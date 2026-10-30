-- Run once as a PostgreSQL administrator. Creates NEW dedicated local resources.
-- Does not install PostgreSQL. Does not contain passwords. Do not run on existing roles/DBs.
CREATE ROLE adamlife_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE adamlife_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- Set passwords interactively in psql: \password adamlife_migrator / \password adamlife_app
-- CREATE DATABASE must run outside a transaction.
CREATE DATABASE adamlife OWNER adamlife_migrator;
REVOKE ALL ON DATABASE adamlife FROM PUBLIC;
GRANT CONNECT ON DATABASE adamlife TO adamlife_app;
