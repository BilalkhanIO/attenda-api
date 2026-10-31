import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { approvalsQuerySchema, approvalReviewSchema } from '../schemas/approvals';
import { ApprovalType, listPendingApprovals, reviewApproval } from '../services/approval-workflows';
import { ok } from '../utils/response';

const router = Router();
router.use(authenticate);

router.get('/', validate({ query: approvalsQuerySchema }), async (req, res, next) => {
  try {
    const data = await listPendingApprovals({ userId: req.user!.sub, orgId: req.user!.org_id }, req.query.type as ApprovalType | 'all' | undefined);
    ok(res, data);
  } catch (error) { next(error); }
});

router.post('/review', validate({ body: approvalReviewSchema }), async (req, res, next) => {
  try {
    const data = await reviewApproval({ userId: req.user!.sub, orgId: req.user!.org_id }, req.body);
    ok(res, data);
  } catch (error) { next(error); }
});

export default router;
