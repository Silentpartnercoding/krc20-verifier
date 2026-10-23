/** Fetch the real-tx test fixtures through the cached, rate-limited client and copy them into test/fixtures. */
import { writeFileSync, mkdirSync } from "node:fs";
import { KaspaApi } from "../sources/kaspaApi.js";

const FIXTURES: Record<string, string> = {
  "nacho-deploy": "85359b7768ba60cde4559b6e03ef2685d27ca7be3b1fa2cda976743e17f7c3ad",
  "forged-transfer-d599f956": "d599f956b2355699fd3f955f2785bcb08789631e494603a0ed671b33cd14fc6e",
  "nacho-transfer-5cb2dc90": "5cb2dc90ed3ab9a20e35c1348609db1e96d0887beaa663a905560768b987c751", // payload op (DAA >= 2026Q1)
  "nacho-transfer-1410b950": "1410b950176cb50355e79c3fbfb2cbaa49b2d2469e8aed7283a4054ae3dec480", // envelope, current parser era
  "nacho-transfer-b23fc278": "b23fc278c56330fbf435a88ab5eb5591fb7635149ced45b652ed6222d03ef873", // envelope, legacy era
  "nacho-list-0d9316b9": "0d9316b968276a95a90384becb4af15815678546db91b35972d0fd700c114ac0",
  "nacho-send-acd42092": "acd42092c93a1cd3f11fcf60f0cca22526dd82a51e5b51bfac606b6c391dbd5b",
};

const api = new KaspaApi();
mkdirSync("test/fixtures", { recursive: true });
for (const [name, id] of Object.entries(FIXTURES)) {
  const tx = await api.getTransaction(id, "light");
  writeFileSync(`test/fixtures/${name}.json`, JSON.stringify(tx, null, 1));
  console.log(name, tx.transaction_id, "accepted", tx.is_accepted, "blue", tx.accepting_block_blue_score);
}
const blk = await api.getBlock((await api.getTransaction(FIXTURES["nacho-deploy"])).accepting_block_hash);
writeFileSync(`test/fixtures/nacho-deploy-accepting-block.json`, JSON.stringify(blk, null, 1));
console.log("deploy accepting block daa", blk.header?.daaScore, "networkCalls", api.networkCalls);
