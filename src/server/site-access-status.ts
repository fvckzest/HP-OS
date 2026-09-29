import { getBusinessPool } from "./database";

export async function inspectSiteAccessSchema(): Promise<{ ready: boolean; message: string }> {
  try {
    const result = await getBusinessPool().query<{ ready: boolean }>(
      `select to_regclass('hpos.site_api_keys') is not null
          and to_regclass('hpos.site_payment_connection_assignments') is not null as ready`,
    );
    const ready = result.rows[0]?.ready === true;
    return {
      ready,
      message: ready ? "Site authentication and configuration tables are ready." : "Site-access migrations are pending. Run `pnpm local` to apply them.",
    };
  } catch {
    return { ready: false, message: "Site-access configuration is unavailable until the local database migrations are applied." };
  }
}
