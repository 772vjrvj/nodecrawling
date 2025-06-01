// printTree.js
const fs = require("fs");
const path = require("path");

function printDir(dir, depth = 0, maxDepth = 4) {
    if (depth > maxDepth) return;

    const prefix = "│  ".repeat(depth);
    const files = fs.readdirSync(dir);

    for (const file of files) {
        if (file === "node_modules") continue;
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        console.log(`${prefix}├─ ${file}`);
        if (stat.isDirectory()) {
            printDir(fullPath, depth + 1, maxDepth);
        }
    }
}

printDir(process.cwd(), 0);