#!/usr/bin/env node
import { runMain } from "../review-loop-companion.mjs";

const args = process.argv.slice(2);
runMain(args[0] === "run" ? args : ["run", "--scope", "auto", ...args]);
