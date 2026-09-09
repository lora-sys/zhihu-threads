import { describe, it } from "vite-plus/test";
import { contracts } from "./contracts.ts";
describe("eval v3 deterministic contracts", () => {
  for (const item of contracts) it(item.name, item.run);
});
