// Builds browser-specific bundles into dist/chrome and dist/firefox.
// Chrome MV3 only accepts background.service_worker; Firefox only background.scripts.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';

const base = JSON.parse(readFileSync('manifest.json', 'utf8'));
rmSync('dist', { recursive: true, force: true });

for (const target of ['chrome', 'firefox']) {
  const dir = `dist/${target}`;
  mkdirSync(dir, { recursive: true });
  cpSync('src', `${dir}/src`, { recursive: true });
  cpSync('icons', `${dir}/icons`, { recursive: true });

  const m = structuredClone(base);
  if (target === 'firefox') {
    m.background = { scripts: ['src/background.js'] };
    m.browser_specific_settings = { gecko: { id: 'extension@byebot.org', strict_min_version: '128.0' } };
  }
  writeFileSync(`${dir}/manifest.json`, JSON.stringify(m, null, 2) + '\n');
}
console.log('Built dist/chrome and dist/firefox');
