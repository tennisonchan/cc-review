#!/usr/bin/env node
import { runMain } from "../cc-review-companion.mjs";

runMain(["adversarial-review", ...process.argv.slice(2)]);
