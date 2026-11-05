CREATE UNIQUE INDEX "compliance_rules_org_id_code_effective_from_key"
ON "compliance_rules"("org_id", "code", "effective_from");
