import type { AllSettings, SettingsSection, SettingsValue } from "../settings.js";
import type { Transport } from "./transport.js";

export type SettingsView = AllSettings & { canEdit: Record<SettingsSection, boolean> };

export const settingsApi = (t: Transport) => ({
  settings: {
    all: () => t.get<SettingsView>("/settings"),
    save: <S extends SettingsSection>(section: S, value: SettingsValue<S>) => t.put<SettingsView>(`/settings/${section}`, value),
  },
});
