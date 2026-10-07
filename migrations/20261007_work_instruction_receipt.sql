ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS work_instruction_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS work_instruction_received_revision INTEGER,
  ADD COLUMN IF NOT EXISTS work_instruction_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS work_instruction_received_by TEXT;
