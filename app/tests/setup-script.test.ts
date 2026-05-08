const { getNpmrcContent } = require('../scripts/setup');

describe('getNpmrcContent', () => {
  test('returns empty string on darwin', () => {
    expect(getNpmrcContent('darwin')).toBe('');
  });

  test('returns empty string on win32', () => {
    expect(getNpmrcContent('win32')).toBe('');
  });

  test('returns empty string on linux', () => {
    expect(getNpmrcContent('linux')).toBe('');
  });
});
