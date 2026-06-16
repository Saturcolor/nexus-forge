-- Mastermind — Migration 010: add user_name to rooms
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS user_name TEXT;
