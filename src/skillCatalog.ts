/**
 * Loads Hermes skills from ~/.hermes/skills/ directory tree.
 * Each skill is a directory with a SKILL.md file containing YAML frontmatter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SkillEntry {
  name: string;
  description: string;
  category: string;
}

export interface SkillGroup {
  category: string;
  skills: SkillEntry[];
}

/** Scan ~/.hermes/skills/ and return grouped skills sorted alphabetically. */
export function loadHermesSkills(): SkillGroup[] {
  const skillsDir = path.join(os.homedir(), '.hermes', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const groups: SkillGroup[] = [];

  try {
    const categories = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();

    for (const cat of categories) {
      const catDir = path.join(skillsDir, cat);
      const skills: SkillEntry[] = [];

      const entries = fs.readdirSync(catDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const entry of entries) {
        const skillMd = path.join(catDir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillMd)) continue;

        try {
          const content = fs.readFileSync(skillMd, 'utf8');
          const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
          let name = entry.name;
          let description = '';

          if (fmMatch) {
            const nameMatch = /^name:\s*(.+)$/m.exec(fmMatch[1]);
            const descMatch = /^description:\s*(.+)$/m.exec(fmMatch[1]);
            if (nameMatch) name = nameMatch[1].trim();
            if (descMatch) description = descMatch[1].trim();
          }

          skills.push({ name, description, category: cat });
        } catch {
          // Skip unreadable skills
        }
      }

      if (skills.length > 0) {
        skills.sort((a, b) => a.name.localeCompare(b.name));
        groups.push({ category: cat, skills });
      }
    }
  } catch {
    // Skills dir unreadable
  }

  return groups;
}
