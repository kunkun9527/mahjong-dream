import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDefaultProfile, normalizeProfile } from '../mockjs/profile.mjs';

export {
  PROFILE_VERSION, applyRankResult, createDefaultProfile, normalizeProfile, recordMatch, sanitizeNickname,
} from '../mockjs/profile.mjs';

export async function loadProfile(directory) {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'profile.json');
  try {
    return normalizeProfile(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return createDefaultProfile();
    if (!(error instanceof SyntaxError)) throw error;
    const backup = path.join(directory, `profile.corrupt-${Date.now()}.json`);
    await fs.rename(file, backup).catch(() => {});
    console.warn(`[local] Save file corrupt, kept as ${backup} and created a new profile`);
    return createDefaultProfile();
  }
}

export async function saveProfile(directory, profile) {
  const body = `${JSON.stringify(normalizeProfile(profile), null, 2)}\n`;
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'profile.json');
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temporary, body, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        // A Windows read handle or antivirus scan can block the replace; always keep the old profile and try at most three times.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 2) throw error;
        await delay(10 * 2 ** attempt);
      }
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
