/**
 * // HYBRID: BotRegistry — SQLite-backed bot CRUD + built-in seeds.
 */
import {
  type Bot,
  type BotId,
  type BotUpsertInput,
  Bot as BotSchema,
  BotEngine,
  BotError,
  BotHandle,
  HYBRID_BOT_ID,
  HYBRID_MULTI_BOT,
  BotId as BotIdSchema,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import { BUILTIN_BOTS, builtinById } from "./builtins.ts";

type BotRow = {
  readonly id: string;
  readonly handle: string;
  readonly name: string;
  readonly color: string;
  readonly instructions: string;
  readonly provider: string;
  readonly model: string | null;
  readonly runtime_mode: string;
  readonly read_only: number;
  readonly mcp_servers_json: string;
  readonly built_in: number;
  readonly created_at: string;
  readonly updated_at: string;
  // HYBRID: v2
  readonly purpose: string;
  readonly tone: number;
  readonly autonomy: string;
  readonly can_delegate: number;
  readonly partner_engine_json: string | null;
  readonly developer_engine_json: string | null;
  readonly seed_version: number;
  readonly user_modified: number;
  readonly archived_at: string | null;
};

const McpServersJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeMcpServersJson = Schema.encodeSync(McpServersJson);
const decodeMcpServersJson = Schema.decodeSync(McpServersJson);
const EngineJson = Schema.fromJsonString(BotEngine);
const encodeEngineJson = Schema.encodeSync(EngineJson);
const decodeEngineJson = Schema.decodeSync(EngineJson);
const decodeBot = Schema.decodeUnknownSync(BotSchema);

const engineToJson = (engine: Bot["partnerEngine"] | undefined): string | null =>
  engine ? encodeEngineJson(engine) : null;

const botError = (code: BotError["code"], message: string): BotError => ({
  code,
  message,
});

/** Insert missing built-ins and upgrade untouched rows to the current seed. */
export const syncBuiltInSeeds = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    for (const bot of BUILTIN_BOTS) {
      yield* sql`
        INSERT INTO bots (
          id, handle, name, color, instructions, provider, model,
          runtime_mode, read_only, mcp_servers_json, built_in,
          created_at, updated_at,
          purpose, tone, autonomy, can_delegate, partner_engine_json,
          developer_engine_json, seed_version, user_modified, archived_at
        ) VALUES (
          ${bot.id},
          ${bot.handle},
          ${bot.name},
          ${bot.color},
          ${bot.instructions},
          ${bot.provider},
          ${bot.model},
          ${bot.runtimeMode},
          ${bot.readOnly ? 1 : 0},
          ${encodeMcpServersJson([...bot.mcpServers])},
          1,
          ${bot.createdAt},
          ${bot.updatedAt},
          ${bot.purpose},
          ${bot.tone},
          ${bot.autonomy},
          ${bot.canDelegate ? 1 : 0},
          ${engineToJson(bot.partnerEngine)},
          ${engineToJson(bot.developerEngine)},
          ${bot.seedVersion},
          0,
          ${bot.archivedAt}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      // HYBRID: forward-migrate untouched built-ins to the current seed version.
      // HYBRID: a retired built-in is archived even if the user edited it, so it leaves
      // every picker; its rows and old snapshots stay. Runs before the content upgrade,
      // which bumps seed_version for untouched rows.
      if (bot.archivedAt !== null) {
        yield* sql`
          UPDATE bots SET archived_at = ${bot.archivedAt}
          WHERE id = ${bot.id}
            AND built_in = 1
            AND archived_at IS NULL
            AND seed_version < ${bot.seedVersion}
        `;
        yield* sql`
          UPDATE bots SET seed_version = ${bot.seedVersion}
          WHERE id = ${bot.id} AND built_in = 1 AND user_modified = 1
            AND seed_version < ${bot.seedVersion}
        `;
      }
      // HYBRID: the handle moves too (engineer → hybrid), unless another bot already has it.
      yield* sql`
        UPDATE bots SET
          handle = CASE
            WHEN EXISTS (SELECT 1 FROM bots AS other WHERE other.handle = ${bot.handle} AND other.id != ${bot.id})
            THEN handle
            ELSE ${bot.handle}
          END,
          name = ${bot.name},
          color = ${bot.color},
          instructions = ${bot.instructions},
          purpose = ${bot.purpose},
          tone = ${bot.tone},
          autonomy = ${bot.autonomy},
          can_delegate = ${bot.canDelegate ? 1 : 0},
          partner_engine_json = ${engineToJson(bot.partnerEngine)},
          developer_engine_json = ${engineToJson(bot.developerEngine)},
          seed_version = ${bot.seedVersion}
        WHERE id = ${bot.id}
          AND built_in = 1
          AND user_modified = 0
          AND seed_version < ${bot.seedVersion}
      `;
    }
  });

/** True when a built-in upsert still matches the current seed (not a user edit). */
export const builtInUpsertMatchesSeed = (
  seed: Bot,
  input: {
    readonly handle: string;
    readonly name: string;
    readonly color: string;
    readonly instructions: string;
    readonly provider: string;
    readonly model: string | null;
    readonly runtimeMode: string;
    readonly readOnly: boolean;
    readonly mcpServers: ReadonlyArray<string>;
    readonly purpose: string;
    readonly tone: number;
    readonly autonomy: string;
    readonly canDelegate: boolean;
  },
): boolean =>
  input.handle === seed.handle &&
  input.name === seed.name &&
  input.color === seed.color &&
  input.instructions === seed.instructions &&
  input.provider === seed.provider &&
  input.model === seed.model &&
  input.runtimeMode === seed.runtimeMode &&
  input.readOnly === seed.readOnly &&
  encodeMcpServersJson([...input.mcpServers]) === encodeMcpServersJson([...seed.mcpServers]) &&
  input.purpose === seed.purpose &&
  input.tone === seed.tone &&
  input.autonomy === seed.autonomy &&
  input.canDelegate === seed.canDelegate;

const rowToBot = (row: BotRow): Bot =>
  decodeBot({
    id: row.id,
    handle: row.handle,
    name: row.name,
    color: row.color,
    instructions: row.instructions,
    provider: ProviderDriverKind.make(row.provider),
    model: row.model,
    runtimeMode: row.runtime_mode,
    readOnly: row.read_only === 1,
    mcpServers: decodeMcpServersJson(row.mcp_servers_json),
    builtIn: row.built_in === 1,
    purpose: row.purpose,
    tone: row.tone,
    autonomy: row.autonomy,
    canDelegate: row.can_delegate === 1,
    partnerEngine: row.partner_engine_json ? decodeEngineJson(row.partner_engine_json) : null,
    developerEngine: row.developer_engine_json ? decodeEngineJson(row.developer_engine_json) : null,
    seedVersion: row.seed_version,
    userModified: row.user_modified === 1,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class BotRegistry extends Context.Service<
  BotRegistry,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<Bot>>;
    readonly get: (id: BotId) => Effect.Effect<Bot, BotError>;
    readonly getByHandle: (handle: string) => Effect.Effect<Bot, BotError>;
    readonly upsert: (input: BotUpsertInput) => Effect.Effect<Bot, BotError>;
    readonly delete: (id: BotId) => Effect.Effect<void, BotError>;
    /** Soft-archive. Built-ins cannot be archived (reset instead). */
    readonly archive: (id: BotId) => Effect.Effect<Bot, BotError>;
    readonly unarchive: (id: BotId) => Effect.Effect<Bot, BotError>;
    readonly resetBuiltIn: (id: BotId) => Effect.Effect<Bot, BotError>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<Bot>>;
  }
>()("t3/bots/BotRegistry") {}

export interface BotRegistryOptions {
  /** HYBRID_MULTI_BOT. Off: only Hybrid exists; new bots and restores are rejected. */
  readonly multiBot: boolean;
}

const makeBotRegistry = (options: BotRegistryOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.unbounded<ReadonlyArray<Bot>>();

    /** Infra SQL failures are defects; callers only see typed BotError. */
    const runSql = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A> => Effect.orDie(effect);

    const listRows = (): Effect.Effect<ReadonlyArray<Bot>> =>
      runSql(sql<BotRow>`
      SELECT id, handle, name, color, instructions, provider, model,
             runtime_mode, read_only, mcp_servers_json, built_in,
             created_at, updated_at,
             purpose, tone, autonomy, can_delegate, partner_engine_json,
             developer_engine_json, seed_version, user_modified, archived_at
      FROM bots
      ORDER BY handle ASC
    `).pipe(Effect.map((rows) => rows.map(rowToBot)));

    const publish = () =>
      listRows().pipe(
        Effect.flatMap((bots) => PubSub.publish(changes, bots)),
        Effect.asVoid,
      );

    yield* runSql(syncBuiltInSeeds(sql));

    const get = (id: BotId): Effect.Effect<Bot, BotError> =>
      Effect.gen(function* () {
        const rows = yield* runSql(sql<BotRow>`
        SELECT id, handle, name, color, instructions, provider, model,
               runtime_mode, read_only, mcp_servers_json, built_in,
               created_at, updated_at,
               purpose, tone, autonomy, can_delegate, partner_engine_json,
               developer_engine_json, seed_version, user_modified, archived_at
        FROM bots WHERE id = ${id}
      `);
        const row = rows[0];
        if (!row) {
          return yield* Effect.fail(botError("not-found", `Bot ${id} not found`));
        }
        return rowToBot(row);
      });

    const getByHandle = (handle: string): Effect.Effect<Bot, BotError> =>
      Effect.gen(function* () {
        const rows = yield* runSql(sql<BotRow>`
        SELECT id, handle, name, color, instructions, provider, model,
               runtime_mode, read_only, mcp_servers_json, built_in,
               created_at, updated_at,
               purpose, tone, autonomy, can_delegate, partner_engine_json,
               developer_engine_json, seed_version, user_modified, archived_at
        FROM bots WHERE handle = ${handle}
      `);
        const row = rows[0];
        if (!row) {
          return yield* Effect.fail(botError("not-found", `Bot @${handle} not found`));
        }
        return rowToBot(row);
      });

    const upsert = (input: BotUpsertInput): Effect.Effect<Bot, BotError> =>
      Effect.gen(function* () {
        if (!options.multiBot && input.id !== HYBRID_BOT_ID) {
          return yield* Effect.fail(
            botError(
              "invalid",
              "Custom bots are disabled in this version. Only Hybrid can be edited.",
            ),
          );
        }
        const handleOk = Schema.decodeExit(BotHandle)(input.handle);
        if (handleOk._tag === "Failure") {
          return yield* Effect.fail(botError("invalid", "Invalid bot handle"));
        }

        const now = DateTime.formatIso(yield* DateTime.now);
        const id = input.id ?? BotIdSchema.make(`bot-${NodeCrypto.randomUUID()}`);

        if (input.id) {
          const existingRows = yield* runSql(sql<{ readonly id: string }>`
          SELECT id FROM bots WHERE id = ${input.id}
        `);
          if (existingRows.length === 0) {
            return yield* Effect.fail(botError("not-found", `Bot ${input.id} not found`));
          }
        }

        const conflict = yield* runSql(sql<{ readonly id: string }>`
        SELECT id FROM bots WHERE handle = ${input.handle} AND id != ${id}
      `);
        if (conflict.length > 0) {
          return yield* Effect.fail(
            botError("duplicate-handle", `Handle @${input.handle} is already taken`),
          );
        }

        const existingForId = yield* runSql(sql<BotRow>`
        SELECT id, handle, name, color, instructions, provider, model,
               runtime_mode, read_only, mcp_servers_json, built_in,
               created_at, updated_at,
               purpose, tone, autonomy, can_delegate, partner_engine_json,
               developer_engine_json, seed_version, user_modified, archived_at
        FROM bots WHERE id = ${id}
      `);
        const prev = existingForId[0];
        const builtIn = prev ? prev.built_in === 1 : false;
        const createdAt = prev?.created_at ?? now;
        // HYBRID: omitted v2 fields keep their stored value (or the default for new bots).
        const purpose = input.purpose ?? prev?.purpose ?? "";
        const tone = input.tone ?? prev?.tone ?? 50;
        const autonomy = input.autonomy ?? prev?.autonomy ?? "small-changes";
        const canDelegate = input.canDelegate ?? (prev ? prev.can_delegate === 1 : true);
        const partnerEngineJson =
          input.partnerEngine === undefined
            ? (prev?.partner_engine_json ?? null)
            : engineToJson(input.partnerEngine);
        const developerEngineJson =
          input.developerEngine === undefined
            ? (prev?.developer_engine_json ?? null)
            : engineToJson(input.developerEngine);
        const seed = builtIn ? builtinById(id) : undefined;
        // Only mark built-ins user-modified when the upsert actually diverges from the seed.
        // Otherwise opening Settings and saving would poison seed upgrades forever.
        const matchesSeed =
          seed !== undefined &&
          builtInUpsertMatchesSeed(seed, {
            handle: input.handle,
            name: input.name,
            color: input.color,
            instructions: input.instructions,
            provider: input.provider,
            model: input.model,
            runtimeMode: input.runtimeMode,
            readOnly: input.readOnly,
            mcpServers: input.mcpServers,
            purpose,
            tone,
            autonomy,
            canDelegate,
          });
        const userModified = builtIn ? (matchesSeed ? 0 : 1) : (prev?.user_modified ?? 0);
        const seedVersion = matchesSeed ? (seed?.seedVersion ?? 0) : (prev?.seed_version ?? 0);

        yield* runSql(sql`
        INSERT INTO bots (
          id, handle, name, color, instructions, provider, model,
          runtime_mode, read_only, mcp_servers_json, built_in,
          created_at, updated_at,
          purpose, tone, autonomy, can_delegate, partner_engine_json,
          developer_engine_json, seed_version, user_modified
        ) VALUES (
          ${id},
          ${input.handle},
          ${input.name},
          ${input.color},
          ${input.instructions},
          ${input.provider},
          ${input.model},
          ${input.runtimeMode},
          ${input.readOnly ? 1 : 0},
          ${encodeMcpServersJson([...input.mcpServers])},
          ${builtIn ? 1 : 0},
          ${createdAt},
          ${now},
          ${purpose},
          ${tone},
          ${autonomy},
          ${canDelegate ? 1 : 0},
          ${partnerEngineJson},
          ${developerEngineJson},
          ${seedVersion},
          ${userModified}
        )
        ON CONFLICT (id) DO UPDATE SET
          handle = excluded.handle,
          name = excluded.name,
          color = excluded.color,
          instructions = excluded.instructions,
          provider = excluded.provider,
          model = excluded.model,
          runtime_mode = excluded.runtime_mode,
          read_only = excluded.read_only,
          mcp_servers_json = excluded.mcp_servers_json,
          purpose = excluded.purpose,
          tone = excluded.tone,
          autonomy = excluded.autonomy,
          can_delegate = excluded.can_delegate,
          partner_engine_json = excluded.partner_engine_json,
          developer_engine_json = excluded.developer_engine_json,
          seed_version = excluded.seed_version,
          user_modified = excluded.user_modified,
          updated_at = excluded.updated_at
      `);
        const bot = yield* get(id);
        yield* publish();
        return bot;
      });

    const remove = (id: BotId): Effect.Effect<void, BotError> =>
      Effect.gen(function* () {
        const rows = yield* runSql(sql<{ readonly built_in: number }>`
        SELECT built_in FROM bots WHERE id = ${id}
      `);
        const row = rows[0];
        if (!row) {
          return yield* Effect.fail(botError("not-found", `Bot ${id} not found`));
        }
        if (row.built_in === 1) {
          return yield* Effect.fail(
            botError("invalid", "Built-in bots cannot be deleted; reset instead"),
          );
        }
        yield* runSql(sql`DELETE FROM bots WHERE id = ${id}`);
        yield* publish();
      });

    const archive = (id: BotId): Effect.Effect<Bot, BotError> =>
      Effect.gen(function* () {
        const existing = yield* get(id);
        if (existing.builtIn) {
          return yield* Effect.fail(
            botError("invalid", "Built-in bots cannot be archived; reset instead"),
          );
        }
        if (existing.archivedAt !== null) return existing;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* runSql(sql`
        UPDATE bots SET archived_at = ${now}, updated_at = ${now} WHERE id = ${id}
      `);
        const bot = yield* get(id);
        yield* publish();
        return bot;
      });

    const unarchive = (id: BotId): Effect.Effect<Bot, BotError> =>
      Effect.gen(function* () {
        const existing = yield* get(id);
        if (existing.archivedAt === null) return existing;
        if (!options.multiBot) {
          return yield* Effect.fail(
            botError(
              "invalid",
              "Custom bots are disabled in this version, so this bot stays archived.",
            ),
          );
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* runSql(sql`
        UPDATE bots SET archived_at = NULL, updated_at = ${now} WHERE id = ${id}
      `);
        const bot = yield* get(id);
        yield* publish();
        return bot;
      });

    const resetBuiltIn = (id: BotId): Effect.Effect<Bot, BotError> =>
      Effect.gen(function* () {
        const seed = builtinById(id);
        if (!seed) {
          return yield* Effect.fail(botError("not-found", `No built-in bot ${id}`));
        }
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* runSql(sql`
        INSERT INTO bots (
          id, handle, name, color, instructions, provider, model,
          runtime_mode, read_only, mcp_servers_json, built_in,
          created_at, updated_at,
          purpose, tone, autonomy, can_delegate, partner_engine_json,
          developer_engine_json, seed_version, user_modified, archived_at
        ) VALUES (
          ${seed.id},
          ${seed.handle},
          ${seed.name},
          ${seed.color},
          ${seed.instructions},
          ${seed.provider},
          ${seed.model},
          ${seed.runtimeMode},
          ${seed.readOnly ? 1 : 0},
          ${encodeMcpServersJson([...seed.mcpServers])},
          1,
          ${seed.createdAt},
          ${now},
          ${seed.purpose},
          ${seed.tone},
          ${seed.autonomy},
          ${seed.canDelegate ? 1 : 0},
          ${engineToJson(seed.partnerEngine)},
          ${engineToJson(seed.developerEngine)},
          ${seed.seedVersion},
          0,
          NULL
        )
        ON CONFLICT (id) DO UPDATE SET
          handle = excluded.handle,
          name = excluded.name,
          color = excluded.color,
          instructions = excluded.instructions,
          provider = excluded.provider,
          model = excluded.model,
          runtime_mode = excluded.runtime_mode,
          read_only = excluded.read_only,
          mcp_servers_json = excluded.mcp_servers_json,
          purpose = excluded.purpose,
          tone = excluded.tone,
          autonomy = excluded.autonomy,
          can_delegate = excluded.can_delegate,
          partner_engine_json = excluded.partner_engine_json,
          developer_engine_json = excluded.developer_engine_json,
          seed_version = excluded.seed_version,
          user_modified = 0,
          archived_at = NULL,
          built_in = 1,
          updated_at = excluded.updated_at
      `);
        const bot = yield* get(id);
        yield* publish();
        return bot;
      });

    return {
      list: () => listRows(),
      get,
      getByHandle,
      upsert,
      delete: remove,
      archive,
      unarchive,
      resetBuiltIn,
      streamChanges: Stream.fromPubSub(changes),
    } satisfies BotRegistry["Service"];
  });

export const layerWith = (options: BotRegistryOptions) =>
  Layer.effect(BotRegistry, makeBotRegistry(options));

export const layer = layerWith({ multiBot: HYBRID_MULTI_BOT });
