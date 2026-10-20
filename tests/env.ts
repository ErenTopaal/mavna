// the sponsor the browser-test builds are configured with; .test never resolves
export const SPONSOR_URL = "https://sponsor.mavna.test";

// the app's port; the playground, landing and docs take the next three. Set
// MAVNA_TEST_PORT to run beside another checkout's browser tests.
export const BASE_PORT = Number(process.env.MAVNA_TEST_PORT ?? "4319");
export const PORTS = {
  app: BASE_PORT,
  playground: BASE_PORT + 1,
  landing: BASE_PORT + 2,
  docs: BASE_PORT + 3,
} as const;
