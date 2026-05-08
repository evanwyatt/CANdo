const { getNpmrcContent } = require('../scripts/setup');

describe('getNpmrcContent', () => {
  test('returns python path on darwin', () => {
    expect(getNpmrcContent('darwin')).toBe('python=/opt/homebrew/bin/python3.11\n');
  });

  test('returns empty string on win32', () => {
    expect(getNpmrcContent('win32')).toBe('');
  });

  test('returns empty string on linux', () => {
    expect(getNpmrcContent('linux')).toBe('');
  });
});
