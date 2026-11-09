/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Stormcoder contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Skill } from '../skills';

/**
 * Stormcoder's skills, handed to the Claude Code harness the way Claude Code itself loads them.
 *
 * The built-in agent pastes an active skill's whole text into its system prompt. The harness has a
 * better mechanism of its own: each skill is a `SKILL.md` whose short description sits in the prompt
 * and whose body is read only when the model decides it applies (the `Skill` tool). So in engine mode
 * Stormcoder's skills are written out as a small local plugin the harness loads natively, and nothing
 * is pasted into the prompt: a skill is loaded in one place only, and one that is never used costs a
 * line of description rather than thousands of tokens.
 */

/** Longest `name` / `description` a `SKILL.md` may have (Claude Code's own limits). */
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
/** Plugin folders kept on disk besides the one in use. Older ones may still be read by a running turn. */
const KEEP_FOLDERS = 3;
/** A plugin folder used within this long is never removed: a long run may still be reading its skills. */
const PRUNE_MIN_AGE_MS = 60 * 60_000;

/** The plugin's name; its skills appear to the model as `stormcoder:<slug>`. */
export const PLUGIN_NAME = 'stormcoder';

/** A skill as written for the harness. */
export interface EngineSkill {
	/** The `SKILL.md` name: lowercase letters, digits and hyphens. */
	readonly slug: string;
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** A lowercase, hyphenated name a `SKILL.md` accepts, unique among `taken`. */
export function skillSlug(id: string, taken: ReadonlySet<string>): string {
	const base = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME - 4) || 'skill';
	let slug = base;
	for (let n = 2; taken.has(slug); n++) {
		slug = `${base}-${n}`;
	}
	return slug;
}

/** Collapses a description to one line within the harness's limit; frontmatter cannot carry more. */
function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Which skills the harness is given. The bundled skills are opt-in in Stormcoder (some rewrite files,
 * and each would put its description in every request), so they are offered only while switched on.
 * Skills the user wrote (settings, or `.stormcoder/skills`) are offered always: the user made them to be
 * used. A project's skill is repository-supplied text the model may follow, so it is offered only in a
 * trusted folder. A skill with no instructions is left out: it would be a description pointing at nothing.
 */
export function selectEngineSkills(skills: readonly Skill[], trusted: boolean, active: readonly string[] = []): EngineSkill[] {
	const taken = new Set<string>();
	const out: EngineSkill[] = [];
	for (const skill of skills) {
		if (!skill.instructions.trim() || (skill.source === 'file' && !trusted) || (skill.source === 'built-in' && !active.includes(skill.id))) {
			continue;
		}
		const slug = skillSlug(skill.id, taken);
		taken.add(slug);
		out.push({
			slug,
			id: skill.id,
			name: skill.name,
			description: oneLine(skill.description || skill.name, MAX_DESCRIPTION),
			body: skill.instructions,
		});
	}
	return out;
}

/** The `SKILL.md` text for one skill. */
export function renderSkillFile(skill: EngineSkill): string {
	// Claude Code runs !`command` in a skill body when the skill loads; Stormcoder's skills are instructions, not
	// scripts, and such a command would not pass through the tool bridge. A space defuses it.
	const body = skill.body.trim().replace(/!`/g, '! `');
	// JSON strings are valid YAML scalars, which keeps a colon or quote in a description from breaking the header.
	return `---\nname: ${skill.slug}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${body}\n`;
}

/** A short digest of what would be written, so an unchanged set is never rewritten. */
function digest(skills: readonly EngineSkill[]): string {
	const hash = createHash('sha256');
	for (const skill of skills) {
		hash.update(skill.slug).update('\0').update(renderSkillFile(skill)).update('\0');
	}
	return hash.digest('hex').slice(0, 16);
}

/**
 * Writes the skills as a local plugin under `root` and returns its folder, or undefined when there is
 * nothing to offer or the write failed (the turn then runs without Stormcoder's skills; it never
 * fails because of them). Each distinct set gets its own folder, written to a temporary name and
 * renamed into place, so a turn that is reading one never sees a half-written or changing plugin.
 */
export async function writeSkillsPlugin(root: string, skills: readonly EngineSkill[], minAgeMs = PRUNE_MIN_AGE_MS): Promise<string | undefined> {
	if (!skills.length) {
		return undefined;
	}
	try {
		const target = path.join(root, digest(skills));
		if (fs.existsSync(path.join(target, '.claude-plugin', 'plugin.json'))) {
			// Used again: mark it recent so a run reading it is not pruned by a newer set.
			const now = new Date();
			await fs.promises.utimes(target, now, now).catch(() => undefined);
			return target;
		}
		// Unique per writer: two turns starting in the same millisecond must not share a staging folder.
		const staging = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
		await fs.promises.mkdir(path.join(staging, '.claude-plugin'), { recursive: true });
		await fs.promises.writeFile(
			path.join(staging, '.claude-plugin', 'plugin.json'),
			JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Stormcoder skills, loaded by the Claude Code engine.' }, null, 2),
		);
		for (const skill of skills) {
			const dir = path.join(staging, 'skills', skill.slug);
			await fs.promises.mkdir(dir, { recursive: true });
			await fs.promises.writeFile(path.join(dir, 'SKILL.md'), renderSkillFile(skill));
		}
		try {
			await fs.promises.rename(staging, target);
		} catch (err) {
			// A concurrent turn wrote the same set first; that copy is identical, so use it.
			await fs.promises.rm(staging, { recursive: true, force: true });
			if (!fs.existsSync(path.join(target, '.claude-plugin', 'plugin.json'))) {
				throw err;
			}
		}
		await prune(root, path.basename(target), minAgeMs);
		return target;
	} catch {
		return undefined;
	}
}

/** Removes all but the newest few plugin folders (and any abandoned temporary ones). Never throws. */
async function prune(root: string, keep: string, minAgeMs: number): Promise<void> {
	try {
		const entries = await fs.promises.readdir(root, { withFileTypes: true });
		const dated: { name: string; mtime: number }[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === keep) {
				continue;
			}
			const stat = await fs.promises.stat(path.join(root, entry.name));
			if (entry.name.includes('.tmp-') && Date.now() - stat.mtimeMs < 10 * 60_000) {
				continue; // another turn is still writing it
			}
			if (Date.now() - stat.mtimeMs < minAgeMs) {
				continue; // possibly in use by a run that is still going
			}
			dated.push({ name: entry.name, mtime: stat.mtimeMs });
		}
		dated.sort((a, b) => b.mtime - a.mtime);
		for (const old of dated.slice(KEEP_FOLDERS - 1)) {
			await fs.promises.rm(path.join(root, old.name), { recursive: true, force: true });
		}
	} catch {
		// Housekeeping only.
	}
}

/**
 * What to tell the harness about the skills the user switched on. The built-in agent pastes those
 * skills into every request; here the model is told to open them with the `Skill` tool, which loads
 * the text once, only when the turn needs it.
 */
export function activeSkillsPrompt(active: readonly string[], offered: readonly EngineSkill[]): string | undefined {
	const names = active.map(id => offered.find(s => s.id === id)).filter((s): s is EngineSkill => !!s).map(s => `${PLUGIN_NAME}:${s.slug}`);
	if (!names.length) {
		return undefined;
	}
	return `The user has switched on these skills for this chat: ${names.join(', ')}. Open each with the Skill tool before you begin and follow it for this work.`;
}
