---
description: Show running LLM cost totals accrued by the cost-tracker plugin. Reads ~/.glorious/opencode/costs.json (or $GLORIOUS_COST_TRACKER_DIR/costs.json) and prints a human-readable breakdown by provider and model. Pass `--json` to dump the raw rollup; pass `--log` to tail the event log. No arguments shows the sorted pretty-print.
---

User input: $ARGUMENTS

You are a read-only reporter for the cost-tracker plugin. Your job: run a short node one-liner to read the rollup file and print results. Do NOT guess, do NOT invent numbers, do NOT modify any files.

## What to do

Parse `$ARGUMENTS` for flags. Behavior:

- **No args** (default) → pretty-print the rollup.
- **`--json`** → dump the raw `costs.json` content verbatim.
- **`--log`** or **`--tail`** → show the last 20 lines of `costs.jsonl`.

## Resolving the data directory

The rollup lives at `${GLORIOUS_COST_TRACKER_DIR:-~/.glorious/opencode}/costs.json` (tilde-expand `~` via `$HOME`). Check `$GLORIOUS_COST_TRACKER_DIR` first; fall back to `$HOME/.glorious/opencode`.

## Pretty-print (default)

Run this node one-liner (node is always available under OpenCode/Claude Code). Use the `bash` tool:

```bash
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const overrideDir=process.env.GLORIOUS_COST_TRACKER_DIR;
let dir;
if(overrideDir){dir=overrideDir.startsWith("~")?path.join(os.homedir(),overrideDir.slice(1)):overrideDir;}
else{dir=path.join(os.homedir(),".glorious","opencode");}
const p=path.join(dir,"costs.json");
let r;
try{r=JSON.parse(fs.readFileSync(p,"utf8"));}
catch(e){
  if(e.code==="ENOENT"){console.log("No cost data yet at "+p+". Start a session with the cost-tracker plugin enabled and come back.");process.exit(0);}
  console.error("Failed to read "+p+": "+e.message);process.exit(1);
}
const fmt=n=>(n==null?"0":Number(n).toFixed(n>=1?2:6));
const fmtTok=t=>{if(!t)return"0";const parts=[];if(t.input)parts.push("in "+t.input);if(t.output)parts.push("out "+t.output);if(t.reasoning)parts.push("reason "+t.reasoning);if(t.cache&&(t.cache.read||t.cache.write)){if(t.cache.read)parts.push("cache-r "+t.cache.read);if(t.cache.write)parts.push("cache-w "+t.cache.write);}return parts.join(", ")||"0";};
console.log("");
console.log("  Total: $"+fmt(r.grandTotal.cost)+"  ("+(r.grandTotal.messages||0)+" messages, "+fmtTok(r.grandTotal.tokens)+")");
console.log("  Updated: "+r.updatedAt);
console.log("");
const provs=Object.entries(r.byProvider||{}).sort((a,b)=>(b[1].cost||0)-(a[1].cost||0));
for(const[provID,prov]of provs){
  console.log("  "+provID+"  $"+fmt(prov.cost)+"  ("+(prov.messages||0)+" msgs)");
  const models=Object.entries(prov.byModel||{}).sort((a,b)=>(b[1].cost||0)-(a[1].cost||0));
  for(const[modID,mod]of models){
    console.log("    "+modID+"  $"+fmt(mod.cost)+"  ("+(mod.messages||0)+" msgs, "+fmtTok(mod.tokens)+")");
  }
}
console.log("");
console.log("  Source: "+p);
'
```

## `--json` branch

Just `cat` the rollup, or use a tiny node wrapper to handle the dir resolution:

```bash
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const overrideDir=process.env.GLORIOUS_COST_TRACKER_DIR;
const dir=overrideDir?(overrideDir.startsWith("~")?path.join(os.homedir(),overrideDir.slice(1)):overrideDir):path.join(os.homedir(),".glorious","opencode");
const p=path.join(dir,"costs.json");
try{process.stdout.write(fs.readFileSync(p,"utf8"));}
catch(e){if(e.code==="ENOENT"){console.log("{}");process.exit(0);}console.error(e.message);process.exit(1);}
'
```

## `--log` / `--tail` branch

Show the last 20 lines of `costs.jsonl`:

```bash
node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const overrideDir=process.env.GLORIOUS_COST_TRACKER_DIR;
const dir=overrideDir?(overrideDir.startsWith("~")?path.join(os.homedir(),overrideDir.slice(1)):overrideDir):path.join(os.homedir(),".glorious","opencode");
const p=path.join(dir,"costs.jsonl");
try{const lines=fs.readFileSync(p,"utf8").split(/\n/).filter(Boolean);for(const l of lines.slice(-20))console.log(l);}
catch(e){if(e.code==="ENOENT"){console.log("No event log yet at "+p+".");process.exit(0);}console.error(e.message);process.exit(1);}
'
```

## Ad-hoc queries

The user may ask follow-up questions like "how much did I spend on Claude Opus yesterday?" or "total cost this week". For those, read `${dir}/costs.jsonl` directly with the Read tool (or cat it), parse the lines in memory, and answer from the data. Each jsonl line contains `ts` (ISO timestamp), `sessionID`, `messageID`, `providerID`, `modelID`, `costDelta`, `costTotal`, `finalized`. Only lines with `finalized: true` represent settled message costs — use `costTotal` on finalized lines to avoid double-counting deltas.

## Output

Print the node output verbatim. Do NOT add commentary unless the user asked a specific question. Keep it tight.
