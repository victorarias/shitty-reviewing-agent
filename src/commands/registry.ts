import type { CommandDefinition } from "../types.js";

export class CommandRegistry {
  private readonly byId = new Map<string, CommandDefinition>();

  constructor(commands: CommandDefinition[]) {
    for (const command of commands) {
      const id = command.id.trim();
      if (!id) {
        throw new Error("Command id cannot be empty.");
      }
      if (this.byId.has(id)) {
        throw new Error(`Duplicate command id: ${id}`);
      }
      this.byId.set(id, command);
    }
  }

  get(id: string): CommandDefinition | undefined {
    return this.byId.get(id);
  }

  list(): CommandDefinition[] {
    return [...this.byId.values()];
  }
}
