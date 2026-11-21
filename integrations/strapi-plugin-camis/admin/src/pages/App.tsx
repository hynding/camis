import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Dialog,
  Flex,
  ProgressBar,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { Layouts, Page, useFetchClient, useRBAC } from '@strapi/strapi/admin';

type DataType = 'content' | 'files' | 'config';
type Direction = 'push' | 'pull';

interface Transfer {
  direction: Direction;
  selection: { only?: DataType[]; exclude?: DataType[] };
  state: 'running' | 'done' | 'failed';
  stage?: string;
  progress?: { done: number; total: number };
  counts?: Record<string, number>;
  diffs?: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

interface Status {
  configured: boolean;
  missing: string[];
  running?: Transfer;
  url: string;
}

const TYPES: Array<{ type: DataType; label: string; hint: string }> = [
  { type: 'content', label: 'Content', hint: 'entries, relations and media library records' },
  { type: 'files', label: 'Files', hint: 'the uploaded files themselves' },
  { type: 'config', label: 'Settings', hint: 'core store and webhooks' },
];

const STAGES: Record<string, string> = {
  exporting: 'Writing this project’s archive',
  uploading: 'Sending it to CAMIS',
  checking: 'CAMIS is checking the content model',
  applying: 'CAMIS is importing it',
  downloading: 'Fetching CAMIS’s archive',
  importing: 'Importing it here',
};

const PERMISSIONS = {
  push: [{ action: 'plugin::camis.push', subject: null }],
  pull: [{ action: 'plugin::camis.pull', subject: null }],
};

/** CAMIS counts each content type apart, Strapi's engine by stage: both read as stages here. */
const summary = (counts: Record<string, number> | undefined): string => {
  const stages: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts ?? {})) {
    const stage = key.includes('::') ? 'entities' : key;
    stages[stage] = (stages[stage] ?? 0) + count;
  }
  return Object.entries(stages)
    .map(([stage, count]) => `${count} ${stage}`)
    .join(', ');
};

const when = (iso: string): string => new Date(iso).toLocaleString();

export const App = () => {
  const { get, post } = useFetchClient();
  const { allowedActions } = useRBAC(PERMISSIONS);
  const [status, setStatus] = useState<Status>();
  const [history, setHistory] = useState<Transfer[]>([]);
  const [included, setIncluded] = useState<DataType[]>(['content', 'files', 'config']);
  const [diffs, setDiffs] = useState<string[]>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);

  const refresh = useCallback(async () => {
    const [{ data: s }, { data: h }] = await Promise.all([
      get<{ data: Status }>('/camis/status'),
      get<{ data: Transfer[] }>('/camis/history'),
    ]);
    setStatus(s.data);
    setHistory(h.data);
  }, [get]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = status?.running;
  useEffect(() => {
    if (running === undefined) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const selection = included.length === TYPES.length ? {} : { only: included };

  const start = async (direction: Direction, force = false) => {
    setError(undefined);
    try {
      await post(`/camis/${direction}`, { ...selection, force });
    } catch (e) {
      setError(
        (e as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? String(e),
      );
    }
    await refresh();
  };

  const check = async () => {
    setChecking(true);
    setError(undefined);
    try {
      const { data } = await post<{ data: { diffs: string[] } }>('/camis/check');
      setDiffs(data.data.diffs);
    } catch (e) {
      setError(
        (e as { response?: { data?: { error?: { message?: string } } } }).response?.data?.error?.message ?? String(e),
      );
    }
    setChecking(false);
  };

  const confirm = (direction: Direction, label: string, body: string, force = false) => (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button
          variant={direction === 'pull' ? 'danger-light' : 'default'}
          disabled={!status?.configured || running !== undefined || included.length === 0}
        >
          {label}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content>
        <Dialog.Header>{label}</Dialog.Header>
        <Dialog.Body>
          <Typography>{body}</Typography>
        </Dialog.Body>
        <Dialog.Footer>
          <Dialog.Cancel>
            <Button variant="tertiary">Cancel</Button>
          </Dialog.Cancel>
          <Dialog.Action>
            <Button variant="danger-light" onClick={() => void start(direction, force)}>
              {label}
            </Button>
          </Dialog.Action>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );

  return (
    <Page.Main>
      <Page.Title>CAMIS</Page.Title>
      <Layouts.Header
        title="CAMIS"
        subtitle={status?.url ? `Syncing with ${status.url}` : 'Push this project to CAMIS, and pull it back'}
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          {status && !status.configured && (
            <Alert variant="warning" title="Not connected" closeLabel="Close">
              Set {status.missing.join(' and ')} in config/plugins, for example{' '}
              <code>
                camis: {'{'} config: {'{'} url: env('CAMIS_URL'), token: env('CAMIS_TRANSFER_TOKEN') {'}'} {'}'}
              </code>
              . The token is a transfer token made in CAMIS under Settings › Transfer Tokens.
            </Alert>
          )}
          {error && (
            <Alert variant="danger" title="Transfer refused" closeLabel="Close" onClose={() => setError(undefined)}>
              {error}
            </Alert>
          )}

          <Box background="neutral0" padding={6} shadow="filterShadow" hasRadius>
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Typography variant="delta" tag="h2">
                What to transfer
              </Typography>
              <Flex gap={6} wrap="wrap">
                {TYPES.map(({ type, label, hint }) => (
                  <Checkbox
                    key={type}
                    checked={included.includes(type)}
                    onCheckedChange={(on: boolean) =>
                      setIncluded((list) => (on ? [...list, type] : list.filter((t) => t !== type)))
                    }
                  >
                    {label} <Typography textColor="neutral600">({hint})</Typography>
                  </Checkbox>
                ))}
              </Flex>
              <Flex gap={2} wrap="wrap">
                <Button
                  variant="secondary"
                  loading={checking}
                  disabled={!status?.configured}
                  onClick={() => void check()}
                >
                  Check content model
                </Button>
                {allowedActions.canPush &&
                  confirm(
                    'push',
                    'Push to CAMIS',
                    'CAMIS’s data of the chosen kinds is replaced with this project’s. Its content model is not changed.',
                  )}
                {allowedActions.canPull &&
                  confirm(
                    'pull',
                    'Pull from CAMIS',
                    'This project’s data of the chosen kinds is replaced with CAMIS’s. Admin users and API tokens stay as they are.',
                  )}
              </Flex>
              {diffs && diffs.length === 0 && (
                <Alert
                  variant="success"
                  title="Content model matches"
                  closeLabel="Close"
                  onClose={() => setDiffs(undefined)}
                >
                  Everything this project holds has somewhere to go in CAMIS.
                </Alert>
              )}
              {diffs && diffs.length > 0 && (
                <Alert
                  variant="warning"
                  title="CAMIS lacks part of this content model"
                  closeLabel="Close"
                  onClose={() => setDiffs(undefined)}
                >
                  {diffs.join('; ')}. Run <code>camis import strapi</code> on this project, regenerate and deploy CAMIS,
                  then push.
                </Alert>
              )}
            </Flex>
          </Box>

          {running && (
            <Box background="neutral0" padding={6} shadow="filterShadow" hasRadius>
              <Flex direction="column" alignItems="stretch" gap={3}>
                <Typography variant="delta" tag="h2">
                  {running.direction === 'push' ? 'Pushing' : 'Pulling'}…
                </Typography>
                <Typography>{STAGES[running.stage ?? ''] ?? 'Starting'}</Typography>
                {running.progress && (
                  <ProgressBar
                    value={Math.round((running.progress.done / Math.max(running.progress.total, 1)) * 100)}
                  />
                )}
              </Flex>
            </Box>
          )}

          <Box background="neutral0" shadow="filterShadow" hasRadius>
            <Table colCount={5} rowCount={history.length + 1}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">Transfer</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Started</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Data</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Result</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Details</Typography>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {history.map((transfer) => (
                  <Tr key={transfer.startedAt + transfer.direction}>
                    <Td>
                      <Typography>{transfer.direction === 'push' ? 'Push' : 'Pull'}</Typography>
                    </Td>
                    <Td>
                      <Typography>{when(transfer.startedAt)}</Typography>
                    </Td>
                    <Td>
                      <Typography>{transfer.selection.only?.join(', ') ?? 'everything'}</Typography>
                    </Td>
                    <Td>
                      <Badge active={transfer.state === 'done'}>{transfer.state === 'done' ? 'Done' : 'Failed'}</Badge>
                    </Td>
                    <Td>
                      <Typography textColor={transfer.state === 'failed' ? 'danger600' : 'neutral800'}>
                        {transfer.state === 'done'
                          ? summary(transfer.counts)
                          : [transfer.error, ...(transfer.diffs ?? [])].join(' ')}
                      </Typography>
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
        </Flex>
      </Layouts.Content>
    </Page.Main>
  );
};
