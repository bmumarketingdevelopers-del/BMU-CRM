import { StyleSheet, Text, View } from 'react-native';
import { GATES, type GateTrack as Track } from '@bmu/shared';
import { colors, fonts } from './theme';

const fill = { passed: colors.green, open: colors.statusAmber, locked: colors.grey } as const;

/** Five-segment gate track ("milestones" in the client app). */
export function GateTrack({ track }: { track: Track }) {
  return (
    <View>
      <View style={styles.row} accessibilityLabel="Milestones">
        {GATES.map((g) => (
          <View key={g.id} style={[styles.segment, { backgroundColor: fill[track[g.id]] }]} />
        ))}
      </View>
      <View style={styles.row}>
        {GATES.map((g) => (
          <Text key={g.id} style={styles.label} numberOfLines={2}>
            {g.name}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1, height: 8 },
  label: { flex: 1, fontSize: 10, color: colors.muted, marginTop: 4, fontFamily: fonts.body },
});
