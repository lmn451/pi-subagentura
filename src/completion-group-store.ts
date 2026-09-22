import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  constants,
} from "node:fs";
import { readdir, open } from "node:fs/promises";
import { join } from "node:path";

export interface PersistedCompletionGroup {
  groupId: string;
  members: string[];
  sealed: boolean;
}

export function hasCompletionGroups(directory: string): boolean {
  return existsSync(directory);
}

/** Only groups containing durable workflows need a persisted unfinished barrier. */
export function writeCompletionGroup(
  directory: string,
  group: PersistedCompletionGroup,
): void {
  if (!group.members.some((member) => member.startsWith("workflow:wfd_")))
    return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(group.groupId).digest("hex");
  const target = join(directory, `${name}.json`);
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, ...group }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function removeCompletionGroup(directory: string, groupId: string): void {
  const name = createHash("sha256").update(groupId).digest("hex");
  try {
    unlinkSync(join(directory, `${name}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export async function readCompletionGroups(
  directory: string,
): Promise<PersistedCompletionGroup[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  names = names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
  if (names.length > 512)
    throw new Error("Persisted completion group limit exceeded.");
  const groups: PersistedCompletionGroup[] = [];
  for (const name of names) {
    const file = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16 * 1024)
        throw new Error("Invalid completion group snapshot.");
      const value = JSON.parse(await file.readFile("utf8"));
      if (
        value.version !== 1 ||
        typeof value.groupId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.groupId) ||
        typeof value.sealed !== "boolean" ||
        !Array.isArray(value.members) ||
        value.members.length > 32 ||
        value.members.some(
          (m: unknown) =>
            typeof m !== "string" ||
            !/^(workflow|interactive|in-process):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(
              m,
            ),
        )
      ) {
        throw new Error("Invalid completion group snapshot.");
      }
      if (
        createHash("sha256").update(value.groupId).digest("hex") + ".json" !==
        name
      )
        throw new Error("Completion group identity mismatch.");
      groups.push(value);
    } finally {
      await file.close();
    }
  }
  return groups;
}
