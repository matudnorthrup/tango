import { afterEach, describe, expect, it, vi } from "vitest";

const { createClientMock, spawnMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("@1password/sdk", () => ({
  createClient: createClientMock,
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

afterEach(() => {
  delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
  vi.clearAllMocks();
});

describe("getSecret", () => {
  it("resolves service-account secrets through the SDK without starting the CLI daemon", async () => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_test_token";
    createClientMock.mockResolvedValue({
      secrets: {
        resolve: vi.fn().mockResolvedValue({ content: { secret: "resolved-secret" } }),
      },
    });

    const { getSecret } = await import("../src/op-secret.js");

    await expect(getSecret("Example Vault", "Example Item")).resolves.toBe("resolved-secret");
    expect(createClientMock).toHaveBeenCalledWith({
      auth: "ops_test_token",
      integrationName: "tango-runtime",
      integrationVersion: "1.0.0",
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
