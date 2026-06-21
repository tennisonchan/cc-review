#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

const args = process.argv.slice(2);
runMain(args[0] === "run" ? args : ["run", "--scope", "auto", "--stance", "adversarial", ...args]);
