pipeline {
  agent any
  triggers { pollSCM('H/2 * * * *') }
  options { disableConcurrentBuilds(); timestamps(); buildDiscarder(logRotator(numToKeepStr: '30')); timeout(time: 35, unit: 'MINUTES') }
  parameters {
    choice(name: 'BUILD_SCOPE', choices: ['auto', 'frontend', 'backend', 'agent-service', 'frontend,backend', 'frontend,agent-service', 'backend,agent-service', 'all'], description: 'auto detects changed paths. Use an explicit scope only for a deliberate rebuild/release of selected components.')
  }
  environment { REGISTRY = 'ghcr.io/ducanhslvp' }
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Detect affected components') { steps { script {
      def detected = sh(script: '''set -eu
        base="${GIT_PREVIOUS_SUCCESSFUL_COMMIT:-}"
        if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
          changed="$(git diff --name-only "$base" HEAD)"
        else
          changed="$(git diff-tree --no-commit-id --name-only -r HEAD)"
        fi
        affected=""
        printf '%s\\n' "$changed" | grep -q '^frontend/' && affected="frontend" || true
        printf '%s\\n' "$changed" | grep -q '^backend/' && affected="${affected:+$affected,}backend" || true
        printf '%s\\n' "$changed" | grep -q '^agent-service/' && affected="${affected:+$affected,}agent-service" || true
        printf '%s' "$affected"''', returnStdout: true).trim()
      env.AFFECTED_COMPONENTS = params.BUILD_SCOPE == 'auto' ? detected : (params.BUILD_SCOPE == 'all' ? 'frontend,backend,agent-service' : params.BUILD_SCOPE)
      currentBuild.description = env.AFFECTED_COMPONENTS ? "components: ${env.AFFECTED_COMPONENTS}" : 'configuration-only change'
      echo env.AFFECTED_COMPONENTS ? "Affected components: ${env.AFFECTED_COMPONENTS}" : 'No application image needs rebuilding.'
    } } }
    stage('Test backend') { when { expression { env.AFFECTED_COMPONENTS?.tokenize(',')?.contains('backend') } } steps { sh '''set -eu
      host_workspace="/srv/jenkins_home${WORKSPACE#/var/jenkins_home}"
      docker run --rm -v "$host_workspace/backend:/source:ro" python:3.12-slim sh -c 'cp -a /source /app && cd /app && pip install --no-cache-dir -e ".[dev]" && pytest -q' ''' } }
    stage('Test frontend') { when { expression { env.AFFECTED_COMPONENTS?.tokenize(',')?.contains('frontend') } } steps { sh '''set -eu
      host_workspace="/srv/jenkins_home${WORKSPACE#/var/jenkins_home}"
      docker run --rm -v "$host_workspace/frontend:/source:ro" -w /source node:24-alpine sh -c 'npm ci && npm run lint && npm run build' ''' } }
    stage('Test agent-service') { when { expression { env.AFFECTED_COMPONENTS?.tokenize(',')?.contains('agent-service') } } steps { sh '''set -eu
      host_workspace="/srv/jenkins_home${WORKSPACE#/var/jenkins_home}"
      docker run --rm -v "$host_workspace/agent-service:/source:ro" python:3.12-slim sh -c 'cp -a /source /app && cd /app && pip install --no-cache-dir -r requirements.txt && pytest -q' ''' } }
    stage('Build selected immutable images') { when { expression { return !!env.AFFECTED_COMPONENTS } } steps { sh '''set -eu
      tag="$(git rev-parse --short=12 HEAD)"
      case ",$AFFECTED_COMPONENTS," in *,frontend,*) docker build -t "$REGISTRY/cloudtool-frontend:$tag" -f frontend/Dockerfile.production frontend ;; esac
      case ",$AFFECTED_COMPONENTS," in *,backend,*) docker build -t "$REGISTRY/cloudtool-backend:$tag" -f backend/Dockerfile.production backend ;; esac
      case ",$AFFECTED_COMPONENTS," in *,agent-service,*) docker build -t "$REGISTRY/cloudtool-agent-service:$tag" -f agent-service/Dockerfile . ;; esac''' } }
    stage('Publish selected images to GHCR') { when { expression { return !!env.AFFECTED_COMPONENTS } } steps { withCredentials([string(credentialsId: 'ghcr-cloudtool-write-token', variable: 'GHCR_TOKEN')]) { sh '''set -eu
      tag="$(git rev-parse --short=12 HEAD)"
      printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u ducanhslvp --password-stdin
      case ",$AFFECTED_COMPONENTS," in *,frontend,*) docker push "$REGISTRY/cloudtool-frontend:$tag" ;; esac
      case ",$AFFECTED_COMPONENTS," in *,backend,*) docker push "$REGISTRY/cloudtool-backend:$tag" ;; esac
      case ",$AFFECTED_COMPONENTS," in *,agent-service,*) docker push "$REGISTRY/cloudtool-agent-service:$tag" ;; esac
      docker logout ghcr.io''' } } }
    stage('Publish release candidate') { when { expression { return !!env.AFFECTED_COMPONENTS } } steps { sh '''set -eu
      tag="$(git rev-parse --short=12 HEAD)"
      release_dir="$JENKINS_HOME/cloudtool-release"
      mkdir -p "$release_dir"
      printf 'tag=%s\\ncomponents=%s\\n' "$tag" "$AFFECTED_COMPONENTS" > "$release_dir/latest-successful-candidate.tmp"
      mv "$release_dir/latest-successful-candidate.tmp" "$release_dir/latest-successful-candidate"
      echo "Release candidate recorded: $tag ($AFFECTED_COMPONENTS)"''' } }
    stage('Release handoff') { steps {
      echo 'CI completed. Run CloudTool-Production-Release with ACTION=promote to create a reviewed GitOps PR.'
    } }
  }
}
