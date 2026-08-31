import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const propagation = new Trend("pvp_state_propagation_ms", true);
const reconnect = new Trend("pvp_reconnect_ms", true);
const commandErrors = new Rate("pvp_command_errors");
const duplicateSettlement = new Counter("pvp_duplicate_settlement");

export const options = {
  scenarios: {
    rooms: {
      executor: "constant-vus",
      vus: 500,
      duration: "10m",
    },
  },
  thresholds: {
    pvp_state_propagation_ms: ["p(95)<800"],
    pvp_reconnect_ms: ["p(95)<3000"],
    pvp_command_errors: ["rate<0.005"],
    pvp_duplicate_settlement: ["count==0"],
    http_req_failed: ["rate<0.005"],
  },
};

export default function () {
  const base = __ENV.EMBER_API_URL;
  const token = __ENV.EMBER_LOAD_TOKEN;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const start = Date.now();
  const response = http.post(`${base}/v1/pvp/sessions`, JSON.stringify({ format: "standard", transport: "poll" }), { headers });
  propagation.add(Date.now() - start);
  commandErrors.add(response.status >= 400);
  check(response, { "session accepted": (value) => value.status === 200 || value.status === 201 });
  if (response.json("duplicateSettlement") === true) duplicateSettlement.add(1);
  const reconnectStarted = Date.now();
  http.get(`${base}/v1/pvp/events?cursor=0`, { headers });
  reconnect.add(Date.now() - reconnectStarted);
  sleep(0.2);
}
