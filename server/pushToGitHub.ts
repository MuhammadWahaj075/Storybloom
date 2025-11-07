import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';

let connectionSettings: any;

async function getAccessToken() {
  if (connectionSettings && connectionSettings.settings.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    return connectionSettings.settings.access_token;
  }
  
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=github',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('GitHub not connected');
  }
  return accessToken;
}

async function getUncachableGitHubClient() {
  const accessToken = await getAccessToken();
  return new Octokit({ auth: accessToken });
}

async function getAllFiles(dir: string, baseDir = dir): Promise<Array<{path: string, content: string}>> {
  const files: Array<{path: string, content: string}> = [];
  
  const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'tmp'];
  const skipFiles = ['.env', '.env.local', '.env.production', '.DS_Store'];
  
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);
      
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name) && !entry.name.startsWith('.')) {
          const subFiles = await getAllFiles(fullPath, baseDir);
          files.push(...subFiles);
        }
      } else {
        if (!skipFiles.includes(entry.name) && !entry.name.startsWith('.')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            files.push({
              path: relativePath.replace(/\\/g, '/'),
              content
            });
          } catch (error) {
            console.log(`Skipping binary file: ${relativePath}`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error);
  }
  
  return files;
}

async function pushToBranch(owner: string, repoName: string, branchName: string, commitMessage: string) {
  const octokit = await getUncachableGitHubClient();
  
  console.log(`Working with repository: ${owner}/${repoName}`);
  
  // Get the repository
  let repo: any;
  try {
    const { data } = await octokit.rest.repos.get({
      owner,
      repo: repoName,
    });
    repo = data;
    console.log(`Repository found: ${repo.html_url}`);
  } catch (error: any) {
    if (error.status === 404) {
      console.log(`Repository not found, creating new repository: ${repoName}`);
      const { data } = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        description: "StoryBloom - AI-powered children's storybook creator",
        private: false,
      });
      repo = data;
      console.log(`Repository created: ${repo.html_url}`);
    } else {
      throw error;
    }
  }
  
  // Get the main branch reference
  let mainCommitSha: string | null = null;
  try {
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo: repoName,
      ref: 'heads/main',
    });
    mainCommitSha = data.object.sha;
    console.log(`Main branch found, commit SHA: ${mainCommitSha}`);
  } catch (error) {
    console.log('Main branch not found, will create it with initial commit');
  }
  
  // Get all files
  const files = await getAllFiles(process.cwd());
  console.log(`Found ${files.length} files to commit`);
  
  // Create blobs for all files
  const blobs: Array<{path: string, mode: string, type: string, sha: string}> = [];
  for (const file of files) {
    try {
      const { data: blob } = await octokit.rest.git.createBlob({
        owner,
        repo: repoName,
        content: Buffer.from(file.content).toString('base64'),
        encoding: 'base64',
      });
      blobs.push({
        path: file.path,
        mode: '100644',
        type: 'blob',
        sha: blob.sha,
      });
    } catch (error: any) {
      if (error.status !== 409) {
        console.error(`Error creating blob for ${file.path}:`, error.message);
      }
    }
  }
  
  console.log(`Created ${blobs.length} blobs`);
  
  // Create tree
  const treeData: any = {
    owner,
    repo: repoName,
    tree: blobs,
  };
  
  if (mainCommitSha) {
    treeData.base_tree = mainCommitSha;
  }
  
  const { data: tree } = await octokit.rest.git.createTree(treeData);
  console.log(`Tree created: ${tree.sha}`);
  
  // Create commit
  const commitData: any = {
    owner,
    repo: repoName,
    message: commitMessage,
    tree: tree.sha,
  };
  
  if (mainCommitSha) {
    commitData.parents = [mainCommitSha];
  }
  
  const { data: commit } = await octokit.rest.git.createCommit(commitData);
  console.log(`Commit created: ${commit.sha}`);
  
  // Create or update the branch reference
  try {
    // Try to get the branch first
    await octokit.rest.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${branchName}`,
    });
    
    // Branch exists, update it
    await octokit.rest.git.updateRef({
      owner,
      repo: repoName,
      ref: `heads/${branchName}`,
      sha: commit.sha,
      force: true,
    });
    console.log(`Updated existing branch: ${branchName}`);
  } catch (error: any) {
    if (error.status === 404) {
      // Branch doesn't exist, create it
      await octokit.rest.git.createRef({
        owner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: commit.sha,
      });
      console.log(`Created new branch: ${branchName}`);
    } else {
      throw error;
    }
  }
  
  console.log(`\n✅ Successfully pushed to ${owner}/${repoName} on branch ${branchName}`);
  console.log(`🔗 Repository URL: ${repo.html_url}`);
  console.log(`🌿 Branch URL: ${repo.html_url}/tree/${branchName}`);
  
  return {
    repo,
    commit,
    branchUrl: `${repo.html_url}/tree/${branchName}`
  };
}

// Get GitHub username
async function getGitHubUsername() {
  const octokit = await getUncachableGitHubClient();
  const { data: user } = await octokit.rest.users.getAuthenticated();
  return user.login;
}

// Main execution
async function main() {
  try {
    const owner = await getGitHubUsername();
    const repoName = 'storybloom';
    const branchName = 'Replit-Changes';
    const commitMessage = `Complete StoryBloom rebranding with legal pages and footer

- Rebranded entire app from StoryMagic to StoryBloom
- Added comprehensive Terms of Service (17 sections)
- Updated Privacy Policy
- Created site-wide footer with social media and legal links
- Set governing law to California/Los Angeles
- Fixed scroll-to-top behavior for legal pages
- Updated all documentation and meta tags`;
    
    await pushToBranch(owner, repoName, branchName, commitMessage);
  } catch (error) {
    console.error('Error pushing to GitHub:', error);
    throw error;
  }
}

main();
