/**
 * GNIL rebrand guard: the retired "GHL" brand must never reappear in
 * user-visible strings in the GNIL OS app. Scans every source file under
 * src/ (excluding tests) for the token "GHL"; fails with the offending
 * file/line so the regression is obvious.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..');

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'test') continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('GNIL rebrand guard', () => {
  it('no source file contains the retired "GHL" brand token', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\bGHL\b/.test(line)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `Retired "GHL" branding found:\n${offenders.join('\n')}`).toEqual([]);
  });
});
