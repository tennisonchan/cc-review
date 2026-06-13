#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

runMain(["cancel", ...process.argv.slice(2)]);
