import AdminEscalation from '../components/ext/AdminEscalation';
import { PageHeader } from '../components/ui';

/** Blocker escalation and aging, reachable by managers and admins without the full Administration console. */
export default function Blockers() {
  return (
    <div>
      <PageHeader title="Blocker escalation" subtitle="Open blockers by working-day age, who they wait on, and the escalation ladder. No person ranking." />
      <AdminEscalation />
    </div>
  );
}
