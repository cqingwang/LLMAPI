import { createFileRoute } from '@tanstack/react-router';
import RequestDetailGlobalPage from '@/features/requests/components/request-detail-global-page';
import { ensureSessionIdInURL } from '@/stores/authStore';
import { useEffect } from 'react';

function GlobalRequestDetail() {
  useEffect(() => {
    ensureSessionIdInURL();
  }, []);

  return <RequestDetailGlobalPage />;
}

export const Route = createFileRoute('/_authenticated/requests/$requestId')({
  component: GlobalRequestDetail,
});
