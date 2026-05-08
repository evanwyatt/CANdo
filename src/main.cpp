//
// CANable 2.0 Pro — binary COBS bridge
//
// All packets (both directions) are COBS-encoded and delimited by 0x00.
// First byte of each decoded packet is the type byte.
//
// Device → App packet types:
//   0x01  PKT_CAN_FRAME  [4B id LE][1B flags][1B dlc][N bytes data]
//   0x02  PKT_RESPONSE   [1B status: 0x00=OK, 0xFF=KO]
//   0x03  PKT_HELLO      (no payload) — handshake reply
//
// App → Device command types:
//   0x01  CMD_SET_SPEED  [1B speed_idx 0-7]
//   0x02  CMD_OPEN       (no payload)
//   0x03  CMD_CLOSE      (no payload)
//   0x04  CMD_TRANSMIT   [4B id LE][1B flags][1B dlc][N bytes data]
//   0x05  CMD_HELLO      (no payload) — handshake initiation
//
// Flags byte:
//   bit 0: EXT — 29-bit extended ID
//   bit 1: RTR — remote transmission request
//
// Speed table at PCLK1 = 64 MHz (prescaler × (1 + tseg1 + tseg2)):
//   S1 → 1.000 Mbps  (4  × 16 = 64)   S5 → 4.923 Mbps  (1  × 13 = 13)
//   S2 → 2.000 Mbps  (2  × 16 = 32)   S6 → 5.818 Mbps  (1  × 11 = 11)
//   S3 → 3.048 Mbps  (1  × 21 = 21)   S7 → 7.111 Mbps  (1  ×  9 =  9)
//   S4 → 4.000 Mbps  (1  × 16 = 16)   S8 → 8.000 Mbps  (1  ×  8 =  8)
//
// Pin assignments (STM32G431C8T6):
//   FDCAN1_RX → PB8 (AF9)    LED_WORK → PA0  (active low)
//   FDCAN1_TX → PB9 (AF9)    LED_SATA → PA15 (active low)
//
// Clock: SYSCLK=128 MHz (PLL_R), FDCAN=64 MHz (PLL_Q), USB=48 MHz (HSI48)
//

#include <Arduino.h>
#include <string.h>
#include "cobs.h"

// ── Pin assignments ───────────────────────────────────────────────────────────
static constexpr uint32_t PIN_LED_WORK = PA0;
static constexpr uint32_t PIN_LED_SATA = PA15;

static constexpr uint8_t LED_ON  = LOW;
static constexpr uint8_t LED_OFF = HIGH;
static constexpr uint32_t LED_ON_MS = 30;

// ── Protocol constants ────────────────────────────────────────────────────────
static constexpr uint8_t PKT_CAN_FRAME = 0x01;
static constexpr uint8_t PKT_RESPONSE  = 0x02;
static constexpr uint8_t PKT_HELLO     = 0x03;
static constexpr uint8_t CMD_SET_SPEED = 0x01;
static constexpr uint8_t CMD_OPEN      = 0x02;
static constexpr uint8_t CMD_CLOSE     = 0x03;
static constexpr uint8_t CMD_TRANSMIT  = 0x04;
static constexpr uint8_t CMD_HELLO     = 0x05;
static constexpr uint8_t FLAG_EXT      = 0x01;
static constexpr uint8_t FLAG_RTR      = 0x02;

// ── Speed table ───────────────────────────────────────────────────────────────
struct BitTiming { uint32_t prescaler, tseg1, tseg2; };
static const BitTiming SPEED_TABLE[8] = {
    {4, 13, 2}, {2, 13, 2}, {1, 18, 2}, {1, 13, 2},
    {1, 10, 2}, {1,  8, 2}, {1,  6, 2}, {1,  5, 2},
};

// ── Globals ───────────────────────────────────────────────────────────────────
static FDCAN_HandleTypeDef hfdcan1;
static bool    channel_open = false;
static uint8_t speed_idx    = 0;

static uint32_t led_sata_off = 0;
static uint32_t led_work_off = 0;

// Outgoing COBS encode buffer — largest outgoing packet is a CAN frame:
// PKT_CAN_FRAME(1) + id(4) + flags(1) + dlc(1) + data(8) = 15 → COBS max 17
static uint8_t tx_buf[20];

// Incoming: accumulate raw bytes between 0x00 delimiters
static uint8_t rx_raw[80];
static uint8_t rx_raw_len = 0;

// Decoded packet workspace (static to avoid stack pressure)
static uint8_t rx_pkt[78];

// ── System clock: 128 MHz core, 64 MHz FDCAN, 48 MHz USB ─────────────────────
extern "C" void SystemClock_Config(void) {
    RCC_OscInitTypeDef       osc  = {};
    RCC_ClkInitTypeDef       clk  = {};
    RCC_PeriphCLKInitTypeDef pclk = {};

    HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1);

    osc.OscillatorType      = RCC_OSCILLATORTYPE_HSI | RCC_OSCILLATORTYPE_HSI48;
    osc.HSIState            = RCC_HSI_ON;
    osc.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    osc.HSI48State          = RCC_HSI48_ON;
    osc.PLL.PLLState        = RCC_PLL_ON;
    osc.PLL.PLLSource       = RCC_PLLSOURCE_HSI;
    osc.PLL.PLLM            = RCC_PLLM_DIV2;
    osc.PLL.PLLN            = 32;
    osc.PLL.PLLP            = RCC_PLLP_DIV2;
    osc.PLL.PLLQ            = RCC_PLLQ_DIV4;   // 64 MHz → FDCAN
    osc.PLL.PLLR            = RCC_PLLR_DIV2;   // 128 MHz → SYSCLK
    HAL_RCC_OscConfig(&osc);

    clk.ClockType      = RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK |
                         RCC_CLOCKTYPE_PCLK1  | RCC_CLOCKTYPE_PCLK2;
    clk.SYSCLKSource   = RCC_SYSCLKSOURCE_PLLCLK;
    clk.AHBCLKDivider  = RCC_SYSCLK_DIV1;
    clk.APB1CLKDivider = RCC_HCLK_DIV1;
    clk.APB2CLKDivider = RCC_HCLK_DIV1;
    HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_3);

    pclk.PeriphClockSelection = RCC_PERIPHCLK_FDCAN | RCC_PERIPHCLK_USB;
    pclk.FdcanClockSelection  = RCC_FDCANCLKSOURCE_PLL;
    pclk.UsbClockSelection    = RCC_USBCLKSOURCE_HSI48;
    HAL_RCCEx_PeriphCLKConfig(&pclk);
}

// ── HAL MSP: configure FDCAN1 GPIO ───────────────────────────────────────────
extern "C" void HAL_FDCAN_MspInit(FDCAN_HandleTypeDef *hfdcan) {
    if (hfdcan->Instance != FDCAN1) return;
    __HAL_RCC_FDCAN_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    GPIO_InitTypeDef gpio = {};
    gpio.Pin       = GPIO_PIN_8 | GPIO_PIN_9;
    gpio.Mode      = GPIO_MODE_AF_PP;
    gpio.Pull      = GPIO_NOPULL;
    gpio.Speed     = GPIO_SPEED_FREQ_HIGH;
    gpio.Alternate = GPIO_AF9_FDCAN1;
    HAL_GPIO_Init(GPIOB, &gpio);
}

// ── LED helpers ───────────────────────────────────────────────────────────────
static void led_trigger(uint32_t pin, uint32_t &off_time) {
    digitalWrite(pin, LED_ON);
    off_time = millis() + LED_ON_MS;
}

static void led_tick() {
    uint32_t now = millis();
    if (led_sata_off && now >= led_sata_off) { digitalWrite(PIN_LED_SATA, LED_OFF); led_sata_off = 0; }
    if (led_work_off && now >= led_work_off) { digitalWrite(PIN_LED_WORK, LED_OFF); led_work_off = 0; }
}

// Startup twinkle: alternate LEDs
static void led_twinkle() {
    digitalWrite(PIN_LED_WORK, LED_ON);  delay(100);
    digitalWrite(PIN_LED_WORK, LED_OFF); delay(100);
    digitalWrite(PIN_LED_SATA, LED_ON);  delay(100);
    digitalWrite(PIN_LED_SATA, LED_OFF); delay(100);
}

// Hello twinkle: both LEDs together, two quick pulses
static void led_hello_twinkle() {
    for (int i = 0; i < 2; i++) {
        digitalWrite(PIN_LED_WORK, LED_ON);
        digitalWrite(PIN_LED_SATA, LED_ON);
        delay(60);
        digitalWrite(PIN_LED_WORK, LED_OFF);
        digitalWrite(PIN_LED_SATA, LED_OFF);
        delay(60);
    }
}

// ── Protocol send helpers ─────────────────────────────────────────────────────
static void send_response(bool ok) {
    uint8_t payload[2] = { PKT_RESPONSE, ok ? (uint8_t)0x00 : (uint8_t)0xFF };
    size_t n = cobs_encode(payload, sizeof(payload), tx_buf);
    SerialUSB.write(tx_buf, n);
}

static void send_hello_pkt() {
    uint8_t payload[1] = { PKT_HELLO };
    size_t n = cobs_encode(payload, sizeof(payload), tx_buf);
    SerialUSB.write(tx_buf, n);
}

// ── FDCAN init / open / close / set-speed ────────────────────────────────────
static bool fdcan_setup() {
    const BitTiming &bt = SPEED_TABLE[speed_idx];
    hfdcan1.Instance = FDCAN1;
    hfdcan1.Init.ClockDivider       = FDCAN_CLOCK_DIV1;
    hfdcan1.Init.FrameFormat        = FDCAN_FRAME_CLASSIC;
    hfdcan1.Init.Mode               = FDCAN_MODE_NORMAL;
    hfdcan1.Init.AutoRetransmission = DISABLE;
    hfdcan1.Init.TransmitPause      = DISABLE;
    hfdcan1.Init.ProtocolException  = ENABLE;
    hfdcan1.Init.NominalPrescaler     = bt.prescaler;
    hfdcan1.Init.NominalSyncJumpWidth = 1;
    hfdcan1.Init.NominalTimeSeg1      = bt.tseg1;
    hfdcan1.Init.NominalTimeSeg2      = bt.tseg2;
    hfdcan1.Init.DataPrescaler     = 1;
    hfdcan1.Init.DataSyncJumpWidth = 1;
    hfdcan1.Init.DataTimeSeg1      = 1;
    hfdcan1.Init.DataTimeSeg2      = 1;
    hfdcan1.Init.StdFiltersNbr   = 0;
    hfdcan1.Init.ExtFiltersNbr   = 0;
    hfdcan1.Init.TxFifoQueueMode = FDCAN_TX_FIFO_OPERATION;
    if (HAL_FDCAN_Init(&hfdcan1) != HAL_OK) return false;
    HAL_FDCAN_ConfigGlobalFilter(&hfdcan1,
        FDCAN_ACCEPT_IN_RX_FIFO0, FDCAN_ACCEPT_IN_RX_FIFO0,
        FDCAN_FILTER_REMOTE,      FDCAN_FILTER_REMOTE);
    return true;
}

static bool open_channel() {
    if (channel_open) return true;
    if (HAL_FDCAN_Start(&hfdcan1) != HAL_OK) return false;
    channel_open = true;
    return true;
}

static void close_channel() {
    if (!channel_open) return;
    HAL_FDCAN_Stop(&hfdcan1);
    channel_open = false;
}

static bool set_speed(uint8_t idx) {
    bool was_open = channel_open;
    close_channel();
    HAL_FDCAN_DeInit(&hfdcan1);
    speed_idx = idx;
    if (!fdcan_setup()) return false;
    if (was_open) return open_channel();
    return true;
}

// ── Transmit a CAN frame ──────────────────────────────────────────────────────
static void transmit_frame(uint32_t id, uint8_t flags, uint8_t dlc,
                           const uint8_t *data, size_t data_len) {
    if (!channel_open) return;
    FDCAN_TxHeaderTypeDef hdr = {};
    hdr.Identifier          = id;
    hdr.IdType              = (flags & FLAG_EXT) ? FDCAN_EXTENDED_ID : FDCAN_STANDARD_ID;
    hdr.TxFrameType         = (flags & FLAG_RTR) ? FDCAN_REMOTE_FRAME : FDCAN_DATA_FRAME;
    hdr.DataLength          = (uint32_t)(dlc & 0x0F) << 16;
    hdr.ErrorStateIndicator = FDCAN_ESI_ACTIVE;
    hdr.BitRateSwitch       = FDCAN_BRS_OFF;
    hdr.FDFormat            = FDCAN_CLASSIC_CAN;
    hdr.TxEventFifoControl  = FDCAN_NO_TX_EVENTS;
    hdr.MessageMarker       = 0;
    uint8_t frame_data[8]   = {};
    size_t copy = (data_len < (size_t)dlc) ? data_len : (size_t)dlc;
    if (copy > 8) copy = 8;
    memcpy(frame_data, data, copy);
    HAL_FDCAN_AddMessageToTxFifoQ(&hfdcan1, &hdr, frame_data);
    led_trigger(PIN_LED_WORK, led_work_off);
}

// ── Dispatch a decoded packet ─────────────────────────────────────────────────
static void handle_packet(const uint8_t *pkt, size_t len) {
    if (len == 0) return;
    switch (pkt[0]) {
        case CMD_HELLO:
            led_hello_twinkle();
            send_hello_pkt();
            break;

        case CMD_SET_SPEED:
            if (len >= 2 && pkt[1] < 8) send_response(set_speed(pkt[1]));
            else                         send_response(false);
            break;

        case CMD_OPEN:
            send_response(open_channel());
            break;

        case CMD_CLOSE:
            close_channel();
            send_response(true);
            break;

        case CMD_TRANSMIT:
            if (len >= 7) {
                uint32_t id = (uint32_t)pkt[1]
                            | ((uint32_t)pkt[2] << 8)
                            | ((uint32_t)pkt[3] << 16)
                            | ((uint32_t)pkt[4] << 24);
                transmit_frame(id, pkt[5], pkt[6], pkt + 7, len - 7);
            }
            break;
    }
}

// ── Process incoming USB bytes ────────────────────────────────────────────────
static void process_commands() {
    while (SerialUSB.available()) {
        uint8_t b = (uint8_t)SerialUSB.read();
        if (b == 0x00) {
            if (rx_raw_len > 0) {
                size_t dec_len = cobs_decode(rx_raw, rx_raw_len, rx_pkt);
                if (dec_len > 0) handle_packet(rx_pkt, dec_len);
                rx_raw_len = 0;
            }
        } else if (rx_raw_len < sizeof(rx_raw)) {
            rx_raw[rx_raw_len++] = b;
        }
    }
}

// ── Forward received CAN frames over USB CDC ──────────────────────────────────
static void drain_rx_fifo() {
    FDCAN_RxHeaderTypeDef hdr;
    uint8_t raw[8];

    while (HAL_FDCAN_GetRxFifoFillLevel(&hfdcan1, FDCAN_RX_FIFO0) > 0) {
        if (HAL_FDCAN_GetRxMessage(&hfdcan1, FDCAN_RX_FIFO0, &hdr, raw) != HAL_OK)
            break;

        uint8_t dlc        = (uint8_t)((hdr.DataLength >> 16) & 0x0F);
        size_t  byte_count = (dlc <= 8) ? dlc : 8;

        // [PKT_CAN_FRAME][id 4B LE][flags][dlc][data N bytes]
        uint8_t payload[15];
        payload[0] = PKT_CAN_FRAME;
        uint32_t id = hdr.Identifier;
        payload[1]  = (uint8_t)id;
        payload[2]  = (uint8_t)(id >> 8);
        payload[3]  = (uint8_t)(id >> 16);
        payload[4]  = (uint8_t)(id >> 24);
        payload[5]  = 0;
        if (hdr.IdType      == FDCAN_EXTENDED_ID)  payload[5] |= FLAG_EXT;
        if (hdr.RxFrameType == FDCAN_REMOTE_FRAME) payload[5] |= FLAG_RTR;
        payload[6]  = dlc;
        memcpy(payload + 7, raw, byte_count);

        size_t n = cobs_encode(payload, 7 + byte_count, tx_buf);
        SerialUSB.write(tx_buf, n);

        led_trigger(PIN_LED_SATA, led_sata_off);
        led_trigger(PIN_LED_WORK, led_work_off);
    }
}

// ── Arduino entry points ──────────────────────────────────────────────────────
void setup() {
    pinMode(PIN_LED_SATA, OUTPUT);
    pinMode(PIN_LED_WORK, OUTPUT);
    digitalWrite(PIN_LED_SATA, LED_OFF);
    digitalWrite(PIN_LED_WORK, LED_OFF);

    for (int i = 0; i < 5; i++) led_twinkle();

    SerialUSB.begin(0);

    if (!fdcan_setup()) {
        while (true) led_twinkle();
    }
}

void loop() {
    process_commands();
    if (channel_open) drain_rx_fifo();
    led_tick();
}
