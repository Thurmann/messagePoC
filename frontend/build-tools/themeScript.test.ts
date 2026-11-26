// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { compileThemeScript } from './themeScript';

describe('compileThemeScript', () => {
  const out = compileThemeScript();

  it('is a classic script without module syntax', () => {
    expect(out).not.toMatch(/^\s*(import|export)\b/m);
  });

  it('parses as a plain function body', () => {
    expect(() => new Function(out)).not.toThrow();
  });
});
