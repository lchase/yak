import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className="hero__subtitle">{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--secondary button--lg"
            to="/docs/quickstart">
            Quickstart
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/tutorial">
            Tutorial
          </Link>
        </div>
      </div>
    </header>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className="row">
          <div className="col col--8 col--offset-2">
            <Heading as="h2">{title}</Heading>
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title="Resume/cache-first agent orchestration"
      description="yak treats agent steps like build targets: content-addressed caching and journal-based resume, not a black box that reruns from scratch on failure.">
      <HomepageHeader />
      <main>
        <Section title="Most orchestrators bolt resume on. yak starts there.">
          <p>
            If you already want agent orchestration — bounded loops, gates,
            artifact-based steps — you've probably looked at Archon, or
            reached for Temporal/DBOS/Restate underneath a hand-rolled step
            contract. yak's pitch is narrow: it treats agent steps like{' '}
            <strong>build targets</strong>, not opaque function calls.
          </p>
          <p>
            Steps are targets, artifacts are files, cache keys are content
            hashes, resume is incremental rebuild. Every run journals to
            disk — nothing in memory, nothing in a database — so when a
            step fails three steps into a five-step run, resuming re-runs
            exactly one step, not five. Most orchestration tools treat an
            agent call as an opaque black box that reruns the whole
            pipeline from scratch on any failure. yak doesn't.
          </p>
        </Section>

        <Section title="When you should use something else">
          <p>
            <strong>Archon</strong>: if its YAML already covers your
            reference workflow with acceptable ergonomics — bounded loops,{' '}
            <code>interactive: true</code> gates, bash nodes, worktree
            isolation — use Archon. Don't switch for switching's sake.
          </p>
          <p>
            <strong>Temporal, DBOS, or Restate</strong>: if you need waits
            measured in days, or multiple people participating in one run,
            put one of those underneath instead and keep only the
            step-contract layer as your own code. yak's suspend/resume is
            built for a single human answering a gate, not long-horizon or
            multi-party durability.
          </p>
          <p>
            yak is for single-operator, hands-off agent workflows where the
            failure mode you're guarding against is a flaky step burning
            tokens on a full rerun — not a multi-day or multi-person wait.
          </p>
        </Section>

        <Section title="See it for yourself">
          <p>
            The <Link to="/docs/quickstart">quickstart</Link> runs the
            reference workflow against a mock adapter in under a minute —
            free, no API key, just proving the engine (scheduling, caching,
            journaling, resume) actually works. The{' '}
            <Link to="/docs/tutorial">tutorial</Link> goes further: a real
            run, with a real model, actually fixing an actual bug.
          </p>
        </Section>
      </main>
    </Layout>
  );
}
