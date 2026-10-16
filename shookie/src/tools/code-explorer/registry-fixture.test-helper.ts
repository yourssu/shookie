export const registryFixture = { apiUrl: "https://radar.test/internal/v1/shookie/github/repositories", apiKey: "dedicated-test-registry-key" };
export const registeredFixture = { id: "12345678-1234-4234-8234-123456789abc", owner: "yourssu", name: "allowed", instructions: "repo guidance", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
export function registryResponse() { return new Response(JSON.stringify({ repositories: [registeredFixture] })); }
