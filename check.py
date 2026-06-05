import re
import os

schema = open('prisma/schema.prisma').read()
mig_dir = 'prisma/migrations'
migrations = {}

for d in os.listdir(mig_dir):
    p = os.path.join(mig_dir, d, 'migration.sql')
    if os.path.exists(p):
        migrations[d] = open(p).read()

db_schema = {}

for name, sql in migrations.items():
    # CREATE TABLE (IF NOT EXISTS)? "table" OR table
    for match in re.finditer(r'CREATE TABLE (?:IF NOT EXISTS )? "?([a-zA-Z0-9_]+)"? \((.*?)\);', sql, re.DOTALL | re.IGNORECASE):
        table = match.group(1).lower()
        if table not in db_schema: db_schema[table] = set()
        # Parse columns
        for line in match.group(2).split('\n'):
            line = line.strip()
            # remove commas
            if line.endswith(','): line = line[:-1]
            if not line: continue
            # match "col" or col
            parts = line.split()
            if not parts: continue
            col = parts[0].replace('"', '').lower()
            if col not in ('constraint', 'primary', 'foreign', 'unique', 'check'):
                db_schema[table].add(col)

    # ALTER TABLE "table" ADD COLUMN "col" OR ALTER TABLE table ADD COLUMN IF NOT EXISTS col
    for match in re.finditer(r'ALTER TABLE "?([a-zA-Z0-9_]+)"? ADD COLUMN (?:IF NOT EXISTS )?"?([a-zA-Z0-9_]+)"?', sql, re.IGNORECASE):
        table = match.group(1).lower()
        col = match.group(2).lower()
        if table not in db_schema: db_schema[table] = set()
        db_schema[table].add(col)

models = []
current_model = None
current_body = []
for line in schema.split('\n'):
    if line.startswith('model '):
        current_model = line.split()[1]
        current_body = []
    elif line.startswith('}') and current_model:
        models.append((current_model, '\n'.join(current_body)))
        current_model = None
    elif current_model:
        current_body.append(line)

for model, body in models:
    map_match = re.search(r'@@map\("([^"]+)"\)', body)
    table = map_match.group(1).lower() if map_match else model.lower()
    
    if table not in db_schema:
        print(f"MISSING TABLE: {table}")
        continue

    lines = body.strip().split('\n')
    for line in lines:
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('@@'): continue
        parts = line.split()
        if not parts: continue
        field = parts[0].lower()
        
        is_relation = False
        for p in parts[1:]:
            if p.startswith(('User', 'Organisation', 'Shift', 'Attendance', 'Break', 'Remote', 'Leave', 'Overtime', 'Payroll', 'Performance', 'Whatsapp', 'Token', 'InApp', 'Late', 'Plan', 'Permission', 'Org', 'Platform', 'Blog')):
                is_relation = True
        
        if is_relation: continue
        
        if field not in db_schema[table]:
            print(f"MISSING COLUMN: {table}.{field}")

