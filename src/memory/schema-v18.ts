import type Database from 'better-sqlite3';

/** Persist desktop visual evidence outside graph memory, scoped to project and environment. */
export function migrateDesktopVisualLoopV18(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE desktop_baseline_revisions(
        project_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        baseline_key TEXT NOT NULL CHECK(length(CAST(baseline_key AS BLOB)) BETWEEN 1 AND 120),
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 1000000),
        capture_kind TEXT NOT NULL CHECK(capture_kind IN ('window','webview')),
        profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND length(CAST(profile_json AS BLOB))<=4096),
        artifact_ref TEXT NOT NULL CHECK(length(CAST(artifact_ref AS BLOB)) BETWEEN 1 AND 512),
        artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256)=64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
        artifact_bytes INTEGER NOT NULL CHECK(artifact_bytes BETWEEN 1 AND 8388608),
        width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 8192),
        height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 8192 AND width*height<=2097152),
        approval_attestation TEXT NOT NULL CHECK(approval_attestation='caller_attested_approved'),
        created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) BETWEEN 1 AND 100),
        PRIMARY KEY(project_id,environment,baseline_key,revision)
      );
      CREATE INDEX desktop_baselines_latest ON desktop_baseline_revisions(project_id,environment,baseline_key,revision DESC);
      CREATE TRIGGER desktop_baseline_revisions_no_update BEFORE UPDATE ON desktop_baseline_revisions BEGIN SELECT RAISE(ABORT,'desktop baseline revisions are immutable'); END;
      CREATE TRIGGER desktop_baseline_revisions_no_delete BEFORE DELETE ON desktop_baseline_revisions BEGIN SELECT RAISE(ABORT,'desktop baseline revisions are immutable'); END;

      CREATE TABLE desktop_visual_findings(
        project_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        id TEXT NOT NULL,
        screen TEXT NOT NULL CHECK(length(CAST(screen AS BLOB)) BETWEEN 1 AND 200),
        severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
        confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
        category TEXT NOT NULL CHECK(length(CAST(category AS BLOB)) BETWEEN 1 AND 64),
        observed_issue TEXT NOT NULL CHECK(length(CAST(observed_issue AS BLOB)) BETWEEN 1 AND 4000),
        region_json TEXT NOT NULL CHECK(json_valid(region_json) AND length(CAST(region_json AS BLOB))<=1200),
        selector TEXT CHECK(selector IS NULL OR length(CAST(selector AS BLOB))<=500),
        remediation TEXT CHECK(remediation IS NULL OR length(CAST(remediation AS BLOB))<=2000),
        verification_method TEXT CHECK(verification_method IS NULL OR length(CAST(verification_method AS BLOB))<=2000),
        screenshot_ref TEXT NOT NULL CHECK(length(CAST(screenshot_ref AS BLOB)) BETWEEN 1 AND 512),
        screenshot_sha256 TEXT NOT NULL CHECK(length(screenshot_sha256)=64 AND screenshot_sha256 NOT GLOB '*[^0-9a-f]*'),
        screenshot_bytes INTEGER NOT NULL CHECK(screenshot_bytes BETWEEN 1 AND 8388608),
        status TEXT NOT NULL CHECK(status IN ('open','in_progress','resolved','reopened')),
        state_version INTEGER NOT NULL CHECK(state_version BETWEEN 1 AND 1000000),
        created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) BETWEEN 1 AND 100),
        updated_at TEXT NOT NULL CHECK(length(CAST(updated_at AS BLOB)) BETWEEN 1 AND 100),
        PRIMARY KEY(project_id,environment,id)
      );
      CREATE INDEX desktop_findings_status ON desktop_visual_findings(project_id,environment,status,updated_at,id);

      CREATE TABLE desktop_visual_comparisons(
        project_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        id TEXT NOT NULL,
        baseline_key TEXT NOT NULL,
        baseline_revision INTEGER NOT NULL,
        capture_kind TEXT NOT NULL CHECK(capture_kind IN ('window','webview')),
        profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND length(CAST(profile_json AS BLOB))<=4096),
        after_ref TEXT NOT NULL CHECK(length(CAST(after_ref AS BLOB)) BETWEEN 1 AND 512),
        after_sha256 TEXT NOT NULL CHECK(length(after_sha256)=64 AND after_sha256 NOT GLOB '*[^0-9a-f]*'),
        after_bytes INTEGER NOT NULL CHECK(after_bytes BETWEEN 1 AND 8388608),
        diff_ref TEXT NOT NULL CHECK(length(CAST(diff_ref AS BLOB)) BETWEEN 1 AND 512),
        diff_sha256 TEXT NOT NULL CHECK(length(diff_sha256)=64 AND diff_sha256 NOT GLOB '*[^0-9a-f]*'),
        diff_bytes INTEGER NOT NULL CHECK(diff_bytes BETWEEN 1 AND 8388608),
        metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json) AND length(CAST(metrics_json AS BLOB))<=4096),
        created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) BETWEEN 1 AND 100),
        PRIMARY KEY(project_id,environment,id),
        FOREIGN KEY(project_id,environment,baseline_key,baseline_revision)
          REFERENCES desktop_baseline_revisions(project_id,environment,baseline_key,revision)
      );
      CREATE INDEX desktop_comparisons_baseline ON desktop_visual_comparisons(project_id,environment,baseline_key,baseline_revision,created_at,id);
      CREATE TRIGGER desktop_visual_comparisons_no_update BEFORE UPDATE ON desktop_visual_comparisons BEGIN SELECT RAISE(ABORT,'desktop comparisons are immutable'); END;
      CREATE TRIGGER desktop_visual_comparisons_no_delete BEFORE DELETE ON desktop_visual_comparisons BEGIN SELECT RAISE(ABORT,'desktop comparisons are immutable'); END;

      CREATE TABLE desktop_comparison_findings(
        project_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        comparison_id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        PRIMARY KEY(project_id,environment,comparison_id,finding_id),
        FOREIGN KEY(project_id,environment,comparison_id) REFERENCES desktop_visual_comparisons(project_id,environment,id),
        FOREIGN KEY(project_id,environment,finding_id) REFERENCES desktop_visual_findings(project_id,environment,id)
      );
      CREATE INDEX desktop_comparison_findings_finding ON desktop_comparison_findings(project_id,environment,finding_id,comparison_id);
      CREATE TRIGGER desktop_comparison_findings_no_update BEFORE UPDATE ON desktop_comparison_findings BEGIN SELECT RAISE(ABORT,'desktop comparison links are immutable'); END;
      CREATE TRIGGER desktop_comparison_findings_no_delete BEFORE DELETE ON desktop_comparison_findings BEGIN SELECT RAISE(ABORT,'desktop comparison links are immutable'); END;

      CREATE TABLE desktop_finding_events(
        project_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        id TEXT NOT NULL,
        finding_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('reported','transitioned')),
        from_status TEXT CHECK(from_status IS NULL OR from_status IN ('open','in_progress','resolved','reopened')),
        to_status TEXT NOT NULL CHECK(to_status IN ('open','in_progress','resolved','reopened')),
        note TEXT CHECK(note IS NULL OR length(CAST(note AS BLOB))<=2000),
        assessment TEXT CHECK(assessment IS NULL OR length(CAST(assessment AS BLOB))<=2000),
        comparison_id TEXT,
        created_at TEXT NOT NULL CHECK(length(CAST(created_at AS BLOB)) BETWEEN 1 AND 100),
        PRIMARY KEY(project_id,environment,id),
        FOREIGN KEY(project_id,environment,finding_id) REFERENCES desktop_visual_findings(project_id,environment,id),
        FOREIGN KEY(project_id,environment,comparison_id) REFERENCES desktop_visual_comparisons(project_id,environment,id),
        CHECK((action='reported' AND from_status IS NULL AND to_status='open') OR (action='transitioned' AND from_status IS NOT NULL))
      );
      CREATE INDEX desktop_finding_events_history ON desktop_finding_events(project_id,environment,finding_id,created_at,id);
      CREATE TRIGGER desktop_finding_events_no_update BEFORE UPDATE ON desktop_finding_events BEGIN SELECT RAISE(ABORT,'desktop finding events are immutable'); END;
      CREATE TRIGGER desktop_finding_events_no_delete BEFORE DELETE ON desktop_finding_events BEGIN SELECT RAISE(ABORT,'desktop finding events are immutable'); END;
      CREATE TRIGGER desktop_visual_findings_report_immutable BEFORE UPDATE ON desktop_visual_findings
      WHEN NEW.screen IS NOT OLD.screen OR NEW.severity IS NOT OLD.severity OR NEW.confidence IS NOT OLD.confidence
        OR NEW.category IS NOT OLD.category OR NEW.observed_issue IS NOT OLD.observed_issue OR NEW.region_json IS NOT OLD.region_json
        OR NEW.selector IS NOT OLD.selector OR NEW.remediation IS NOT OLD.remediation OR NEW.verification_method IS NOT OLD.verification_method
        OR NEW.screenshot_ref IS NOT OLD.screenshot_ref OR NEW.screenshot_sha256 IS NOT OLD.screenshot_sha256 OR NEW.screenshot_bytes IS NOT OLD.screenshot_bytes
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'desktop finding report details are immutable'); END;
    `);
    database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(18,?)').run(new Date().toISOString());
  })();
}
