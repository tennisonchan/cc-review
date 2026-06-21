#!/usr/bin/env node
import { runMain } from "../review-loop-companion.mjs";

runMain(["cancel", ...process.argv.slice(2)]);
