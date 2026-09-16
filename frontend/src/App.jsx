import { useMemo, useRef, useState, useEffect } from 'react';
import './App.css';

const API_URL = 'http://localhost:8000';

const ACCEPTED_TYPES = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
];

const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(',');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();

  if (ext === 'pdf') return '📄';
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(ext)) return '🖼️';
  return '📎';
}

export default function App() {
  const [tenderId, setTenderId] = useState('');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchingHistory, setFetchingHistory] = useState(false);
  const [batchResults, setBatchResults] = useState([]);
  const [auditHistory, setAuditHistory] = useState([]);
  const [dbHistory, setDbHistory] = useState([]);
  const [errorMessage, setErrorMessage] = useState('');
  const fileInputRef = useRef(null);

  const imageCount = useMemo(
    () =>
      files.filter((file) =>
        ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'].includes(
          file.name.split('.').pop()?.toLowerCase()
        )
      ).length,
    [files]
  );

  const pdfCount = files.length - imageCount;

  // Fetch audit history from MongoDB Atlas via FastAPI on mount
 const fetchDatabaseHistory = async () => {
    setFetchingHistory(true);
    try {
      const response = await fetch(`${API_URL}/audit-history`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || 'Failed to fetch database history.');
      }

      setDbHistory(data);
      setErrorMessage(''); // Clear any previous errors on success
    } catch (error) {
      console.error(error);
      // Removed setErrorMessage here so it won't flash the error banner on initial load
    } finally {
      setFetchingHistory(false);
    }
  };

  useEffect(() => {
    fetchDatabaseHistory();
  }, []);

  const handleFileChange = (event) => {
    const selectedFiles = Array.from(event.target.files || []);

    setErrorMessage('');

    if (!selectedFiles.length) return;

    const validFiles = selectedFiles.filter((file) => {
      const extension = `.${file.name.split('.').pop()?.toLowerCase()}`;
      return ACCEPTED_TYPES.includes(extension);
    });

    if (validFiles.length !== selectedFiles.length) {
      setErrorMessage(
        'Some files were ignored. Supported: PDF, PNG, JPG, JPEG, WEBP, BMP, TIF and TIFF.'
      );
    }

    setFiles(validFiles);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index) => {
    setFiles((previous) => previous.filter((_, fileIndex) => fileIndex !== index));
  };

  const clearFiles = () => {
    setFiles([]);
    setErrorMessage('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!tenderId.trim()) {
      setErrorMessage('Please enter a Tender ID.');
      return;
    }

    if (!files.length) {
      setErrorMessage('Please upload at least one PDF or image document.');
      return;
    }

    setLoading(true);
    setBatchResults([]);
    setErrorMessage('');

    const formData = new FormData();

    files.forEach((file) => {
      formData.append('files', file);
    });

    formData.append('tender_id', tenderId.trim());

    try {
      const response = await fetch(`${API_URL}/verify-batch`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || 'Batch verification failed on server.');
      }

      setBatchResults(data);

      const newEntries = data.map((item) => ({
        id: Date.now() + Math.random(),
        fileName: item.file_name,
        tenderId: tenderId.trim(),
        score: item.compliance_score,
        risk: item.risk_level,
        missing: item.missing_requirements,
        discrepancies: item.discrepancies,
        recommendation: item.recommendation,
        timestamp: new Date().toLocaleTimeString(),
      }));

      setAuditHistory((previous) => [...newEntries, ...previous]);

      // Refresh database logs automatically after successful upload
      fetchDatabaseHistory();
    } catch (error) {
      console.error(error);
      setErrorMessage(
        error.message ||
          'Unable to connect to BidGuard AI backend. Make sure FastAPI is running on port 8000.'
      );
    } finally {
      setLoading(false);
    }
  };

  const downloadReport = (entry) => {
    const reportContent = `
=== BIDGUARD AI - COMPLIANCE AUDIT REPORT ===
Timestamp: ${entry.timestamp || entry.timestamp}
Tender ID: ${entry.tenderId || entry.tender_id}
Document Name: ${entry.fileName || entry.file_name}
---------------------------------------------
Compliance Score: ${entry.score || entry.compliance_score} / 100
Risk Level: ${entry.risk || entry.risk_level} RISK

Missing Statutory Requirements:
${
  (entry.missing || entry.missing_requirements) &&
  (entry.missing || entry.missing_requirements).length > 0
    ? (entry.missing || entry.missing_requirements)
        .map((item) => `- ${item}`)
        .join('\n')
    : '- None detected'
}

Discrepancies:
${
  entry.discrepancies && entry.discrepancies.length > 0
    ? entry.discrepancies.map((item) => `- ${item}`).join('\n')
    : '- None detected'
}

AI Officer Recommendation:
${entry.recommendation}
---------------------------------------------
Note: Final qualification or disqualification decision remains with the authorized Procurement Officer.
    `.trim();

    const blob = new Blob([reportContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    const fileIdentifier = entry.fileName || entry.file_name || 'document';
    const tenderIdentifier = entry.tenderId || entry.tender_id || 'Tender';

    anchor.href = url;
    anchor.download = `Audit_Report_${tenderIdentifier.replace(
      /[/\\?%*:|"<>]/g,
      '_'
    )}_${fileIdentifier}.txt`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const getRiskClass = (risk) => {
    if (risk === 'LOW') return 'bg-green-100 text-green-700';
    if (risk === 'MEDIUM') return 'bg-yellow-100 text-yellow-700';
    return 'bg-red-100 text-red-700';
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-6">
      <header className="max-w-6xl mx-auto mb-8 flex items-center justify-between border-b pb-4">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-lg">
            🛡️
          </div>
          <h1 className="text-2xl font-bold tracking-tight">BidGuard AI</h1>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs bg-emerald-100 text-emerald-700 font-medium px-2.5 py-1 rounded-full flex items-center gap-1">
            🟢 MongoDB Connected
          </span>
          <span className="text-sm bg-blue-100 text-blue-700 font-medium px-3 py-1 rounded-full">
            GeM Compliance Engine
          </span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Upload Form */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 md:col-span-1">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              📑 Batch Verify Bidders
            </h2>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Tender ID
                </label>

                <input
                  type="text"
                  placeholder="e.g. GEM/2026/B/1234567"
                  value={tenderId}
                  onChange={(event) => setTenderId(event.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  Upload Bid Documents
                </label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ACCEPT_ATTRIBUTE}
                  multiple
                  onChange={handleFileChange}
                  className="w-full border rounded-lg px-3 py-2 text-sm file:mr-4 file:py-1 file:px-3 file:rounded-md file:border-0 file:bg-blue-50 file:text-blue-700 font-medium"
                />

                <p className="text-xs text-slate-500 mt-2">
                  PDF + Images supported
                </p>

                <p className="text-[11px] text-slate-400 mt-1">
                  PNG, JPG, JPEG, WEBP, BMP, TIF/TIFF
                </p>
              </div>

              {files.length > 0 && (
                <div className="border rounded-lg bg-slate-50 p-3">
                  <div className="flex justify-between items-center mb-2">
                    <div>
                      <p className="text-sm font-semibold">
                        {files.length} document{files.length > 1 ? 's' : ''} selected
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {pdfCount} PDF{pdfCount !== 1 ? 's' : ''} · {imageCount}{' '}
                        image{imageCount !== 1 ? 's' : ''}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={clearFiles}
                      className="text-xs text-red-600 hover:text-red-800 font-medium"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="space-y-2 max-h-52 overflow-y-auto">
                    {files.map((file, index) => (
                      <div
                        key={`${file.name}-${file.lastModified}-${index}`}
                        className="flex items-center gap-2 bg-white border rounded-md p-2"
                      >
                        <span className="text-lg">{getFileIcon(file.name)}</span>

                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium truncate">{file.name}</p>
                          <p className="text-[10px] text-slate-400">
                            {formatBytes(file.size)}
                          </p>
                        </div>

                        <button
                          type="button"
                          onClick={() => removeFile(index)}
                          className="text-slate-400 hover:text-red-600 text-sm"
                          title="Remove file"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {errorMessage && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg p-3">
                  {errorMessage}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !files.length}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading
                  ? '🔍 Analyzing Documents...'
                  : '🚀 Run Batch Compliance Check'}
              </button>
            </form>
          </div>

          {/* Results */}
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 md:col-span-2 flex flex-col justify-between">
            <div>
              <h2 className="text-lg font-semibold mb-4">
                Batch Ranking & Assessment
              </h2>

              {batchResults.length > 0 ? (
                <div className="space-y-4 max-h-[500px] overflow-y-auto pr-2">
                  {batchResults.map((res, index) => (
                    <div
                      key={`${res.file_name}-${index}`}
                      className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3"
                    >
                      <div className="flex justify-between items-center gap-3">
                        <span
                          className="font-semibold text-slate-800 text-sm truncate"
                          title={res.file_name}
                        >
                          #{index + 1} - {res.file_name}
                        </span>

                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`px-2.5 py-0.5 text-xs font-semibold rounded-full ${getRiskClass(
                              res.risk_level
                            )}`}
                          >
                            {res.risk_level} RISK
                          </span>

                          <span className="font-bold text-blue-600 text-sm">
                            {res.compliance_score}/100
                          </span>
                        </div>
                      </div>

                      <p className="text-xs text-slate-600 bg-white p-2 rounded border border-slate-100">
                        <strong>Recommendation:</strong>{' '}
                        {res.recommendation}
                      </p>

                      {res.missing_requirements?.length > 0 && (
                        <div className="text-xs">
                          <strong className="text-red-700">
                            Missing / Unverified:
                          </strong>
                          <ul className="list-disc ml-5 mt-1 text-slate-600">
                            {res.missing_requirements.map((item, itemIndex) => (
                              <li key={itemIndex}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {res.discrepancies?.length > 0 && (
                        <div className="text-xs">
                          <strong className="text-orange-700">
                            Discrepancies:
                          </strong>
                          <ul className="list-disc ml-5 mt-1 text-slate-600">
                            {res.discrepancies.map((item, itemIndex) => (
                              <li key={itemIndex}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="h-64 flex flex-col items-center justify-center text-slate-400 text-center">
                  <div className="text-3xl mb-2">📊</div>
                  <p className="text-sm max-w-md">
                    Upload vendor PDFs, scanned documents, certificates, or
                    document images and run the batch check to view compliance
                    rankings.
                  </p>
                </div>
              )}
            </div>

            <div className="text-xs text-slate-400 mt-4 border-t pt-2 text-center">
              Final qualification/disqualification decision remains with the
              Procurement Officer.
            </div>
          </div>
        </div>

        {/* Database Audit History Log */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold">MongoDB Audit History</h2>
              <p className="text-xs text-slate-500">Persistent database logs from MongoDB Atlas cluster</p>
            </div>
            <button
              onClick={fetchDatabaseHistory}
              disabled={fetchingHistory}
              className="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition border flex items-center gap-1.5"
            >
              {fetchingHistory ? '🔄 Refreshing...' : '🔄 Refresh Logs'}
            </button>
          </div>

          {dbHistory.length > 0 ? (
            <div className="overflow-x-auto max-h-[400px]">
              <table className="w-full text-left text-sm text-slate-600">
                <thead className="bg-slate-100 text-slate-700 uppercase text-xs sticky top-0">
                  <tr>
                    <th className="p-3">Timestamp</th>
                    <th className="p-3">Tender ID</th>
                    <th className="p-3">File Name</th>
                    <th className="p-3">Score</th>
                    <th className="p-3">Risk Level</th>
                    <th className="p-3 text-right">Action</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-200">
                  {dbHistory.map((entry) => {
                    const formattedTime = entry.timestamp 
                      ? new Date(entry.timestamp).toLocaleTimeString() 
                      : 'Just now';

                    return (
                      <tr key={entry._id} className="hover:bg-slate-50">
                        <td className="p-3 text-xs text-slate-500">{formattedTime}</td>
                        <td className="p-3 font-medium text-slate-800">
                          {entry.tender_id}
                        </td>
                        <td className="p-3">{entry.file_name}</td>
                        <td className="p-3 font-bold text-blue-600">
                          {entry.compliance_score}/100
                        </td>
                        <td className="p-3">
                          <span
                            className={`px-2 py-0.5 text-xs font-semibold rounded-full ${getRiskClass(
                              entry.risk_level
                            )}`}
                          >
                            {entry.risk_level}
                          </span>
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => downloadReport(entry)}
                            className="text-blue-600 hover:text-blue-800 text-xs font-medium underline"
                          >
                            Download Report
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8 text-slate-400 text-xs">
              No audit logs found in the database yet. Run a batch verification to populate records.
            </div>
          )}
        </div>
      </main>
    </div>
  );
}