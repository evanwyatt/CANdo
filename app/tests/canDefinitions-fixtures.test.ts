import * as fs from 'fs';
import * as path from 'path';
import { decodeFrameWithDefinitions, type CanDefinitionFile, type CanMessageDefinition } from '../src/canDefinitions';

// Fixture files use hex strings (e.g. "0x100") or plain numbers for IDs and byte values.
type HexNum = number | string;

function parseHex(v: HexNum): number {
  return typeof v === 'string' ? parseInt(v, 16) : v;
}

interface RawMessageDef extends Omit<CanMessageDefinition, 'id' | 'mask'> {
  id: HexNum;
  mask: HexNum;
}

interface RawDefinitionFile extends Omit<CanDefinitionFile, 'messages'> {
  messages: RawMessageDef[];
}

function normalizeDefinition(raw: RawDefinitionFile): CanDefinitionFile {
  return {
    ...raw,
    messages: raw.messages.map(({ id, mask, ...rest }) => ({
      ...rest,
      id:   parseHex(id),
      mask: parseHex(mask),
    })),
  };
}

interface FixtureFrame {
  id:   HexNum;
  dlc:  number;
  data: HexNum[];
}

interface ExpectedField {
  name:       string;
  value:      string;
  rawValue?:  string;
}

interface FixtureCase {
  description: string;
  frame:       FixtureFrame;
  expected: {
    messageName: string | null;
    fields?:     ExpectedField[];
  };
}

interface FixtureFile {
  description: string;
  definition:  RawDefinitionFile;
  cases:       FixtureCase[];
}

const fixturesDir = path.join(__dirname, 'fixtures', 'definitions');
const fixtureFiles = fs.readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

for (const filename of fixtureFiles) {
  const raw = JSON.parse(
    fs.readFileSync(path.join(fixturesDir, filename), 'utf-8'),
  ) as FixtureFile;
  const definition = normalizeDefinition(raw.definition);

  describe(`${raw.description} [${filename}]`, () => {
    for (const tc of raw.cases) {
      it(tc.description, () => {
        const frame = {
          id:   parseHex(tc.frame.id),
          dlc:  tc.frame.dlc,
          data: Uint8Array.from(tc.frame.data.map(parseHex)),
        };

        const result = decodeFrameWithDefinitions(frame, definition);

        if (tc.expected.messageName === null) {
          expect(result).toBeNull();
          return;
        }

        expect(result).not.toBeNull();
        expect(result?.definition.name).toBe(tc.expected.messageName);

        if (tc.expected.fields !== undefined) {
          expect(result?.values).toEqual(tc.expected.fields);
        }
      });
    }
  });
}
