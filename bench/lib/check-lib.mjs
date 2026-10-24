// Objective check for this task. Returns { pass, notes }; never trusts the model's own claims.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const sh = (dir, cmd) => { try { return { ok: true, out: execFileSync('/bin/sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }) }; } catch (e) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; } };
export const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
/** Reads a file or '' when it does not exist. */
export const read = (dir, rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
/** Every file under dir (relative paths), skipping dependency and VCS folders. */
export function walk(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        if (['.git', 'node_modules', 'venv'].includes(e.name)) { continue; }
        const r = path.join(rel, e.name);
        if (e.isDirectory()) { out.push(...walk(dir, r)); } else { out.push(r); }
    }
    return out;
}
