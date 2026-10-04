'use client';
import { useParams } from 'next/navigation';
import AllocationWorkspace from '../../../../attendance-capacity/allocation-workspace';
export default function OperatorAttendance() {
  const { tenantId } = useParams<{ tenantId: string }>();
  return <AllocationWorkspace key={tenantId} operatorTenant={tenantId} />;
}
