import { AdminGate } from "@/components/admin/AdminGate";
import { ServiceActivationCard } from "@/components/admin/ServiceActivationCard";
import { NoxCueSection } from "@/components/admin/tools/NoxCueSection";
import { getNoxApp, SERVICE_OFF_TEXT } from "@/lib/apps";
import type { OptionalServiceAdminPageProps } from "./types";

export function NoxCueAdminPage(props: OptionalServiceAdminPageProps) {
  return <section className="space-y-6" aria-labelledby="noxcue-page-title">
    <div><h1 id="noxcue-page-title" className="text-xl font-semibold text-stone-900">NoxCue</h1><p className="mt-1 text-sm text-stone-500">Critical detection and daily app statistics, with separate readiness and delivery for each environment.</p></div>
    <ServiceActivationCard app={getNoxApp("noxcue")} enabled={props.enabled} isAdmin={props.isAdmin} isSaving={!props.settingsReady || props.isSaving} hasError={props.hasError} offText={SERVICE_OFF_TEXT.noxcue} onToggle={(_, enabled) => props.onToggle(enabled)} />
    {props.settingsReady && props.enabled ? <AdminGate title="NoxCue settings" description="Configure sources, register custom features, inspect health, manage keys, and choose Slack channels.">
      {props.status ? <NoxCueSection noxConnect={props.status} /> : props.loading}
    </AdminGate> : null}
  </section>;
}
