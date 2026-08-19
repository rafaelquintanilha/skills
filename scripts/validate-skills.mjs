#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repositoryRoot, "skills");
const entries = await readdir(skillsRoot, { withFileTypes: true });
const skillDirectories = entries.filter((entry) => entry.isDirectory());

if (skillDirectories.length === 0) {
  throw new Error("No skill directories found under skills/.");
}

for (const directory of skillDirectories) {
  const skillPath = join(skillsRoot, directory.name, "SKILL.md");
  const contents = await readFile(skillPath, "utf8");
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    throw new Error(`${skillPath} does not contain YAML frontmatter.`);
  }

  const name = frontmatterValue(frontmatter[1], "name");
  const description = frontmatterValue(frontmatter[1], "description");
  if (!name || !description) {
    throw new Error(`${skillPath} requires name and description fields.`);
  }
  if (!/^[a-z0-9-]{1,63}$/.test(name)) {
    throw new Error(`${skillPath} has an invalid skill name: ${name}`);
  }
  if (name !== directory.name) {
    throw new Error(
      `${skillPath} declares ${name}, but its directory is ${directory.name}.`,
    );
  }

  for (const reference of localMarkdownLinks(contents)) {
    await access(join(dirname(skillPath), reference));
  }

  process.stdout.write(`Validated ${name}\n`);
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) {
    return "";
  }
  return match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
}

function localMarkdownLinks(contents) {
  const links = [];
  for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      links.push(decodeURIComponent(target));
    }
  }
  return links;
}
