import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parse } = require('./args.js') as typeof import('./args.js');

describe('strapi-plugin-camis arguments', () => {
  it('reads a command with only, exclude and force', () => {
    expect(parse(['push', '--exclude', 'files,config'])).toEqual({
      command: 'push',
      selection: { exclude: ['files', 'config'] },
      force: false,
    });
    expect(parse(['pull', '--only=content', '--force'])).toEqual({
      command: 'pull',
      selection: { only: ['content'] },
      force: true,
    });
    expect(parse(['check'])).toEqual({ command: 'check', selection: {}, force: false });
  });

  it('refuses what strapi transfer refuses', () => {
    expect(() => parse([])).toThrow('Usage');
    expect(() => parse(['sync'])).toThrow('Usage');
    expect(() => parse(['push', '--only', 'content', '--exclude', 'files'])).toThrow(
      '--only and --exclude cannot both be used',
    );
    expect(() => parse(['push', '--only', 'nonsense'])).toThrow('Invalid data type "nonsense"');
    expect(() => parse(['push', '--verbose'])).toThrow('Unknown option --verbose');
  });
});
