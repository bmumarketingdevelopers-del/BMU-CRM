/**
 * v40: how Workload fills each person's week.
 * - 'assigned_tasks' (now): only the hours the Department Head gave each assigned task count, spread over the working
 *   days from today to the task's deadline; they drop off when the task is done. Bookings are hidden.
 * - 'primary': the original calculation, booked hours + task estimates (loads()).
 * Used by Workload (capacity.service.ts), Capacity (workspace/team.service.ts) and the person picker load (actions/people.ts).
 * "Please revert to primary workload calculation" = set this to 'primary'.
 */
export const WORKLOAD_MODE: 'assigned_tasks' | 'primary' = 'assigned_tasks';
