import { readdirSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillResources } from '../dist/skills.js';
const root = 'skills';
for (const dir of readdirSync(root, {withFileTypes: true}).filter(d => d.isDirectory() && d.name.startsWith('easy-'))) {
  const path = join(root, dir.name);
  for (const [name, source] of Object.entries(skillResources(dir.name))) {
    mkdirSync(join(path, name, '..'), {recursive: true});
    copyFileSync(source, join(path, name));
  }
  const text = readFileSync(join(path, 'SKILL.md'), 'utf8');
  if (!text.startsWith(`---\nname: ${dir.name}\n`) || !text.includes('description: ')) throw new Error('Invalid skill: ' + dir.name);
}
