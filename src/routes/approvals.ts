import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { approvalsQuerySchema, approvalReviewSchema } from '../schemas/approvals';
import { ApprovalType, listPendingApprovals, reviewApproval } from '../services/approval-workflows';
import { ok } from '../utils/response';
import { idempotency } from '../middleware/idempotency';

const router = Router();
router.use(authenticate);

router.get('/', validate({ query: approvalsQuerySchema }), async (req, res, next) => {
  try {
    const type = req.query.type as ApprovalType | 'all' | undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const parsedLimit = Number.parseInt(String(req.query.limit ?? '25'), 10);
    const cursorMode = req.query.cursor_mode === 'true' || req.query.cursor_mode === '1' || !!cursor || req.query.limit !== undefined;
    const data = await listPendingApprovals(
      { userId: req.user!.sub, orgId: req.user!.org_id },
      type,
      cursorMode ? { enabled: true, cursor, limit: Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 25 } : undefined,
    );
    ok(res, data);
  } catch (error) { next(error); }
});

router.post('/review', idempotency, validate({ body: approvalReviewSchema }), async (req, res, next) => {
  try {
    const data = await reviewApproval({ userId: req.user!.sub, orgId: req.user!.org_id }, req.body);
    ok(res, data);
  } catch (error) { next(error); }
});

export default router;
