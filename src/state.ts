import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_PATH = path.resolve(".data/state.json");

export type State = {
  lastProcessedAddedAt?: string;
  lastProfileRebuildTime?: Record<string, string>; // Mapping of playlistId to ISO timestamp
};

export async function readState(): Promise<State> {
  try {
    const buf = await fs.readFile(STATE_PATH);
    return JSON.parse(buf.toString()) as State;
  } catch {
    return {};
  }
}

export async function writeState(state: State) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}
