// v20 push: the phone registers for notifications and offers quick actions right on the notification
// (Approve / Reject, Reply, Done, Snooze). Actions go to the API without opening the app; tapping the
// notification itself opens the related screen.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import type { QuickActionInput } from '@bmu/shared';
import { api } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const label: Record<QuickActionInput['action'], string> = { approve: 'Approve', reject: 'Reject', reply: 'Reply', done: 'Done', snooze: 'Snooze 1h' };
const button = (action: QuickActionInput['action']): Notifications.NotificationAction => ({
  identifier: action,
  buttonTitle: label[action],
  ...(action === 'reply' ? { textInput: { submitButtonTitle: 'Send', placeholder: 'Type a reply' } } : {}),
  options: { opensAppToForeground: false, isDestructive: action === 'reject' },
});

async function categories() {
  await Notifications.setNotificationCategoryAsync('approval', ['approve', 'reject', 'snooze'].map((a) => button(a as QuickActionInput['action'])));
  await Notifications.setNotificationCategoryAsync('message', [button('reply'), button('snooze')]);
  await Notifications.setNotificationCategoryAsync('task', [button('done'), button('snooze')]);
  await Notifications.setNotificationCategoryAsync('general', [button('snooze')]);
}

let token: string | null = null;

/**
 * Asks for permission and registers this phone for push. Returns why it could not, if it could not
 * (simulator, permission refused, or Expo Go on Android, which cannot receive remote pushes).
 */
export async function registerPush(): Promise<string | null> {
  try {
    await categories();
    if (!Device.isDevice) return 'Push needs a real phone.';
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('default', { name: 'BMU Hub', importance: Notifications.AndroidImportance.HIGH });
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return 'Notifications are turned off for BMU Hub in your phone settings.';
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    await api.devices.registerPush(token, Platform.OS === 'ios' ? 'ios' : 'android');
    return null;
  } catch (e) {
    return `Push is not available in this build (${(e as Error).message}). It works in a development or store build.`;
  }
}

/** Stops pushes to this phone (sign-out). */
export async function unregisterPush() {
  if (!token) return;
  await api.devices.unregisterPush(token).catch(() => undefined);
  token = null;
}

/** Handles quick-action buttons and taps. `open` receives the notification's link. Returns an unsubscribe. */
export function listenForPush(open: (link: string | null) => void, toast: (m: string) => void) {
  const sub = Notifications.addNotificationResponseReceivedListener((res) => {
    const data = res.notification.request.content.data as { notificationId?: string; link?: string | null };
    const action = res.actionIdentifier;
    if (action === Notifications.DEFAULT_ACTION_IDENTIFIER || !data?.notificationId) {
      open(data?.link ?? null);
      return;
    }
    const body: QuickActionInput = { notificationId: data.notificationId, action: action as QuickActionInput['action'], ...(res.userText ? { text: res.userText } : {}) };
    void api.devices
      .quickAction(body)
      .then((r) => toast(r.message))
      .catch((e: Error) => toast(e.message))
      .finally(() => void Notifications.dismissNotificationAsync(res.notification.request.identifier).catch(() => undefined));
  });
  return () => sub.remove();
}
