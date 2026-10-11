# Connect Pascal to draft a building

Source review date: 2026-10-11. Source review alone does not prove every host or published runtime works.

`draft_building_from_brief` is an MCP tool of the Pascal server. Check that the connected server lists it before you build a brief for it; installed and hosted releases can differ from this skill's source-review snapshot. Without it, give the user the brief itself, labelled as in the skill, so it can be reviewed or used later.

## Local project

Use the local path when the project should stay on the machine. It needs Node.js 22.13 or newer and no Pascal account:

```bash
npm install --global @pascal-app/cli
pascal editor --no-open
```

Then connect the active host with only its own setup command, for example `pascal mcp setup claude` or `pascal mcp setup codex`. Any other JSON-configured MCP client runs the stable connector:

```json
{
  "mcpServers": {
    "pascal": {
      "command": "pascal",
      "args": ["mcp", "connect"]
    }
  }
}
```

Use one active agent client per local service; concurrent clients share the active scene.

## Existing hosted project

Create an API key in Pascal Settings (`https://editor.pascal.app/settings`) for the same user or organization that owns the target project, and keep it in the host's secret store or an environment variable (`PASCAL_API_KEY`); never print it or put it in source files. The hosted Streamable HTTP endpoint is:

```text
https://editor.pascal.app/api/mcp
```

Send the key as `Authorization: Bearer <key>` through the host's secret mechanism.

## Photos

The photos stay with the AI host: the agent reads them and sends Pascal only the brief, which holds numbers, names and library material ids, never image data. Do not upload the photos anywhere unless the user asks.
