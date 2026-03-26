import { inject } from "@vercel/analytics";

try {
  inject();
} catch (e) {
  console.warn("[analytics]", e);
}
