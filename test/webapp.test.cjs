/** Guards the standalone database webapp and its provider provenance table. */
const assert=require("node:assert/strict"); const fs=require("node:fs"); const path=require("node:path"); const test=require("node:test");
test("webapp exposes provider and cache status",()=>{const html=fs.readFileSync(path.join(__dirname,"../public/index.html"),"utf8"); assert.match(html,/Weather Database/); assert.match(html,/Providers/); assert.match(html,/Latest resolved forecast/);});
